import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import {
  frameContains,
  frameOf,
  nudgeOf,
  pickAt,
  placementOf,
  resizedScale,
  rotatedAngle,
  rotateText,
  scaleText,
  topFirst,
  translateText,
  type CanvasPick,
  type ClipBox,
  type Frame,
  type Placement,
  type PlacementChanges,
  type PlacementStyles,
  type Point,
} from './canvas-geometry'
import type { ComponentCatalog } from './composition/catalog'
import type { CaptionTextChange } from './captions-tab'
import { itemNamed, type Canvas, type FilmClip } from './composition/film'
import { fieldText, textFields, type LocaleBindings } from './composition/locale-text'
import type { ItemTextChange } from './component-texts'
import { useEditorEscape } from './editor-keys'
import { SOURCE_NAME, translationOf, type ShownLocale } from './locales'
import type { PoseStyles, PreviewControl, TextTarget } from './preview-player'

/** 指针按下后挪过这么多屏幕像素才算拖动，不然只是点选。 */
const DRAG_SLOP = 3

/** 同一处再点一次换下一层时，两次离得多近（屏幕像素）算同一处。 */
const SAME_SPOT = 4

/** 旋转把手离选中框底边的空间（屏幕像素）：画面下面放不下时放到框上面。 */
const ROTATE_ROOM = 32

/** 画面上的一层：一个当前显示着、能编辑的片段，和它在画面上的样子。 */
type Layer = { clip: FilmClip; placement: Placement; frame: Frame }

/** 字幕不在画面上挪：它的框就是预览量到的位置。 */
const UNPLACED: Placement = { x: 0, y: 0, angle: 0, scaleX: 1, scaleY: 1 }

/** 拖动改的是哪一样：挪（位移）、角上的把手（缩放）、旋转把手（角度）。 */
type GestureKind = 'move' | 'scale' | 'rotate'

/**
 * 按下以后的这一下：挪（`hits` 是按下处从上往下的片段，`picked` 是按下时选中的那个，没拖动就松手时用它们看要不要
 * 换下一层），或者拖把手。
 */
type Gesture =
  | {
      kind: 'move'
      start: Point
      origins: ReadonlyMap<string, Placement>
      moved: boolean
      hits: readonly string[]
      picked: string
      shift: boolean
    }
  | { kind: 'scale' | 'rotate'; id: string; start: Point; frame: Frame; origin: Placement }

/** 拖动中的样子：改的是哪一样，各片段现在的摆放。 */
type Draft = { kind: GestureKind; placements: ReadonlyMap<string, Placement> }

const STYLE_OF = { move: 'translate', scale: 'scale', rotate: 'rotate' } as const

const styleText = (kind: GestureKind, placement: Placement) =>
  kind === 'move'
    ? translateText(placement.x, placement.y)
    : kind === 'scale'
      ? scaleText(placement.scaleX, placement.scaleY)
      : rotateText(placement.angle)

/** 片段写着的摆放，换成发给预览的那三样（没写的是 null）。 */
const poseOf = (styles: PlacementStyles | undefined): PoseStyles => ({
  translate: styles?.translate ?? null,
  rotate: styles?.rotate ?? null,
  scale: styles?.scale ?? null,
})

type CanvasOverlayProps = {
  canvas: Canvas
  /** final-cut 的片段，按文件里的先后。 */
  clips: readonly FilmClip[]
  placements: ReadonlyMap<string, PlacementStyles>
  /** 预览量出来的各片段的布局框。 */
  boxes: ReadonlyMap<string, ClipBox>
  /** 画面停在第几毫秒（显示着哪些片段按它算）。 */
  frameMs: number
  /** final-cut 换了一份时变；拖到一半换了就取消这次拖动。 */
  revision: number
  selected: ReadonlySet<string>
  controlRef: RefObject<PreviewControl | null>
  onSelect: (ids: ReadonlySet<string>) => void
  /** 松手、按方向键时把摆放写进去（一步撤销）。 */
  onPlace: (changes: PlacementChanges) => void
  /** 拖动、原地改字进行中：这时编辑器的快捷键和 Esc 先让开。 */
  onGesture: (active: boolean) => void
  /** 预览找到的、要原地改的文字；没有在改时是 null。 */
  textTarget: TextTarget | null
  onTextClose: () => void
  catalog: ComponentCatalog
  locale: ShownLocale
  bindings: ReadonlyMap<string, LocaleBindings>
  onText: ItemTextChange
  /** 原地改了一句字幕的字（改的是显示着的这种语言的）。 */
  onCaptionText: CaptionTextChange
  onNotice: (message: string) => void
  /** 编辑层放进这里一个处理方向键的函数：挪了选中的片段时答 true（这一下用掉了）。 */
  nudgeRef: RefObject<CanvasNudge | null>
}

/** 焦点在画面上时按的一个键；挪了画面上选中的片段时答 true。 */
export type CanvasNudge = (event: { key: string; shiftKey: boolean; altKey: boolean }) => boolean

/**
 * 盖在预览画面上的编辑层：点选视频、贴片、场景片段和正在显示的那句字幕（和时间线上的选中是同一个），拖着挪、
 * 拖角上的把手等比缩放、拖旋转把手转（按住 Shift 吸到 15° 的整数倍），方向键挪 1 像素（Shift 10）；双击贴片、
 * 场景里的文字或字幕原地改。拖动中预览先跟着摆（见预览协议的 `pose`），松手写进主文件，算一步撤销。
 *
 * 字幕只能点选、改字，不挪、不缩放、不转；点中它只看正在显示的那句的字占的那块（字幕宿主铺满画面，不算它）。
 */
export function CanvasOverlay({
  canvas,
  clips,
  placements,
  boxes,
  frameMs,
  revision,
  selected,
  controlRef,
  onSelect,
  onPlace,
  onGesture,
  textTarget,
  onTextClose,
  catalog,
  locale,
  bindings,
  onText,
  onCaptionText,
  onNotice,
  nudgeRef,
}: CanvasOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    // 开始观察时就报一次现在的大小
    const observer = new ResizeObserver(() => setWidth(layer.clientWidth))
    observer.observe(layer)
    return () => observer.disconnect()
  }, [])
  // 画布一像素在屏幕上多宽
  const zoom = width > 0 && canvas.width > 0 ? width / canvas.width : 0

  const gestureRef = useRef<Gesture | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  // 最后一次拖到的样子：松手时可能还没重画
  const draftRef = useRef<Draft | null>(null)
  const lastPickRef = useRef<CanvasPick | null>(null)

  const shownAt = (clip: FilmClip) =>
    !clip.hidden && clip.start <= frameMs && frameMs < clip.start + clip.duration
  // 正在显示的字幕叠在所有片段上面
  const captionLayers: Layer[] = clips.flatMap((clip) => {
    const box = boxes.get(clip.id)
    if (clip.kind !== 'caption' || box === undefined || !shownAt(clip)) return []
    return [{ clip, placement: UNPLACED, frame: frameOf(box, UNPLACED) }]
  })
  // 显示着、量得到、摆放读得懂的片段，从最上面一层往下
  const layers: Layer[] = [
    ...captionLayers,
    ...topFirst(
      clips.flatMap((clip) => {
        if (clip.kind !== 'video' && clip.kind !== 'host') return []
        const box = boxes.get(clip.id)
        if (box === undefined || !shownAt(clip)) return []
        const written = placementOf(placements.get(clip.id) ?? {}, box.box)
        if (written === null) return []
        const placement = draft?.placements.get(clip.id) ?? written
        return [{ clip, placement, frame: frameOf(box, placement), z: clip.z }]
      }),
    ),
  ]
  const framed = layers.filter((layer) => selected.has(layer.clip.id))
  // 能在画面上挪的：选中的里面字幕以外的
  const movable = framed.filter((layer) => layer.clip.kind !== 'caption')

  const toCanvas = (event: { clientX: number; clientY: number }): Point => {
    const rect = layerRef.current?.getBoundingClientRect()
    const scale = rect === undefined || rect.width === 0 ? 1 : rect.width / canvas.width
    return {
      x: (event.clientX - (rect?.left ?? 0)) / scale,
      y: (event.clientY - (rect?.top ?? 0)) / scale,
    }
  }

  const showDraft = (next: Draft | null) => {
    draftRef.current = next
    setDraft(next)
  }

  const finish = () => {
    gestureRef.current = null
    showDraft(null)
    onGesture(false)
  }

  /** 取消这次拖动：预览里摆回文件里写的样子。 */
  const cancel = () => {
    for (const id of draftRef.current?.placements.keys() ?? [])
      controlRef.current?.pose(id, poseOf(placements.get(id)))
    finish()
  }

  // final-cut 被换掉（撤销、别处改了……）时这次拖动是按换之前算的，作废
  const cancelStale = useEffectEvent(() => {
    if (gestureRef.current !== null) cancel()
  })
  useEffect(() => {
    cancelStale()
  }, [revision])

  useEditorEscape(draft !== null, cancel)

  /** 把 `kind` 那一样写进去；和文件里写着的一样的不写。 */
  const commit = (kind: GestureKind, next: ReadonlyMap<string, Placement>) => {
    const name = STYLE_OF[kind]
    const changes = new Map(
      [...next].flatMap(([id, placement]) => {
        const text = styleText(kind, placement)
        return text === placements.get(id)?.[name] ? [] : [[id, { [name]: text }] as const]
      }),
    )
    if (changes.size > 0) onPlace(changes)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gestureRef.current !== null) return
    layerRef.current?.focus({ preventScroll: true })
    const point = toCanvas(event)
    const hits = layers
      .filter((layer) => frameContains(layer.frame, point))
      .map((layer) => layer.clip.id)
    // 按下时不换层：选中的还是选中的（按住就能拖），换下一层等没拖动就松手时再看；Shift 加选的是最上面一层
    const id = event.shiftKey ? (hits[0] ?? null) : pickAt(hits, selected, null, point, 0, 0)
    if (id === null) {
      lastPickRef.current = null
      if (!event.shiftKey && selected.size > 0) onSelect(new Set())
      return
    }
    const next = event.shiftKey
      ? new Set([...selected, id])
      : selected.has(id)
        ? selected
        : new Set([id])
    if (next !== selected) onSelect(next)
    const origins = new Map(
      layers.flatMap((layer) =>
        next.has(layer.clip.id) && layer.clip.kind !== 'caption'
          ? [[layer.clip.id, layer.placement] as const]
          : [],
      ),
    )
    gestureRef.current = {
      kind: 'move',
      start: point,
      origins,
      moved: false,
      hits,
      picked: id,
      shift: event.shiftKey,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  /**
   * 没拖动就松手：是一次点选。同一处很快再点一次时换成下一层（见 `pickAt`）。字幕在最上面时点一下就选中它，
   * 不让压在下面、选中着的片段留着（按下时留着它，是为了按住能拖）。
   */
  const clicked = (gesture: Extract<Gesture, { kind: 'move' }>, now: number) => {
    const { hits, picked, start, shift } = gesture
    const cycled =
      pickAt(hits, new Set([picked]), lastPickRef.current, start, now, SAME_SPOT / (zoom || 1)) ??
      picked
    const [top] = hits
    const captionOnTop = layers.some(
      (layer) => layer.clip.id === top && layer.clip.kind === 'caption',
    )
    const id = captionOnTop && top !== undefined && cycled === picked ? top : cycled
    lastPickRef.current = { point: start, at: now, id }
    if (id !== picked && !shift) onSelect(new Set([id]))
  }

  const onHandleDown = (event: PointerEvent<HTMLElement>, kind: 'scale' | 'rotate', at: Layer) => {
    if (event.button !== 0 || gestureRef.current !== null) return
    event.stopPropagation()
    event.preventDefault()
    layerRef.current?.focus({ preventScroll: true })
    gestureRef.current = {
      kind,
      id: at.clip.id,
      start: toCanvas(event),
      frame: at.frame,
      origin: at.placement,
    }
    // 指针交给编辑层，拖出把手以后照样收得到
    layerRef.current?.setPointerCapture(event.pointerId)
    onGesture(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture === null) return
    const point = toCanvas(event)
    let next: Map<string, Placement>
    if (gesture.kind === 'move') {
      const dx = point.x - gesture.start.x
      const dy = point.y - gesture.start.y
      if (!gesture.moved) {
        if (gesture.origins.size === 0 || Math.hypot(dx, dy) * zoom < DRAG_SLOP) return
        gesture.moved = true
        onGesture(true)
      }
      next = new Map(
        [...gesture.origins].map(([id, origin]) => [
          id,
          { ...origin, x: origin.x + dx, y: origin.y + dy },
        ]),
      )
    } else if (gesture.kind === 'scale') {
      const scale = resizedScale(gesture.frame, gesture.origin, gesture.start, point)
      next = new Map([[gesture.id, { ...gesture.origin, ...scale }]])
    } else {
      const center = { x: gesture.frame.cx, y: gesture.frame.cy }
      const angle = rotatedAngle(center, gesture.origin.angle, gesture.start, point, event.shiftKey)
      next = new Map([[gesture.id, { ...gesture.origin, angle }]])
    }
    const name = STYLE_OF[gesture.kind]
    for (const [id, placement] of next)
      controlRef.current?.pose(id, {
        ...poseOf(placements.get(id)),
        [name]: styleText(gesture.kind, placement),
      })
    showDraft({ kind: gesture.kind, placements: next })
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture === null) return
    if (gesture.kind === 'move' && !gesture.moved) {
      gestureRef.current = null
      clicked(gesture, event.timeStamp)
      return
    }
    const last = draftRef.current
    if (last !== null) commit(last.kind, last.placements)
    finish()
  }

  // 焦点在画面上时按的方向键：挪画面上选中的片段（编辑器的快捷键处理经 `nudgeRef` 调）
  useEffect(() => {
    nudgeRef.current = (event) => {
      if (gestureRef.current !== null || event.altKey) return false
      const step = nudgeOf(event.key, event.shiftKey)
      if (step === null || movable.length === 0) return false
      commit(
        'move',
        new Map(
          movable.map(({ clip, placement }) => [
            clip.id,
            { ...placement, x: placement.x + step.x, y: placement.y + step.y },
          ]),
        ),
      )
      return true
    }
    return () => {
      nudgeRef.current = null
    }
  })

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const point = toCanvas(event)
    for (const layer of layers) {
      const { clip } = layer
      if (!frameContains(layer.frame, point)) continue
      if (clip.kind === 'caption') {
        onSelect(new Set([clip.id]))
        controlRef.current?.editText(clip.id, point, [clip.variable])
        return
      }
      if (clip.kind !== 'host') continue
      const item = itemNamed(catalog, clip.item)
      const fields = item === undefined ? [] : textFields(item)
      if (fields.length === 0) continue
      onSelect(new Set([clip.id]))
      controlRef.current?.editText(
        clip.id,
        point,
        fields.map((field) => field.id),
      )
      return
    }
  }

  const closeText = (refocus: boolean) => {
    if (refocus) layerRef.current?.focus({ preventScroll: true })
    onTextClose()
  }

  // 字幕不出缩放、旋转把手
  const single = framed.length === 1 && framed[0]?.clip.kind !== 'caption' ? framed[0] : undefined
  const textEdit =
    textTarget === null
      ? undefined
      : textEditOf(textTarget, clips, { catalog, locale, bindings, onText, onCaptionText })
  // 改着字的片段没了（别处改了 final-cut）：不改了，藏起来的字显示回来
  const orphanText = textTarget !== null && textEdit === undefined
  const dropText = useEffectEvent(() => {
    controlRef.current?.endText(null)
    onGesture(false)
    onTextClose()
  })
  useEffect(() => {
    if (orphanText) dropText()
  }, [orphanText])
  return (
    <div
      aria-label="预览画面"
      className="wf-canvas-layer"
      data-canvas-layer=""
      onDoubleClick={onDoubleClick}
      onLostPointerCapture={onPointerUp}
      onPointerCancel={cancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={layerRef}
      role="group"
      tabIndex={-1}
    >
      {framed.map((layer) => {
        const { clip, frame } = layer
        // 原地改着的字幕：框就是它的字，和输入框叠在一起，不画
        if (clip.kind === 'caption' && textTarget?.id === clip.id) return null
        const below = (frame.cy + frame.height / 2) * zoom + ROTATE_ROOM
        return (
          <div
            aria-label={`选中：${clip.label}`}
            className="wf-canvas-frame"
            key={clip.id}
            role="img"
            style={{
              left: (frame.cx - frame.width / 2) * zoom,
              top: (frame.cy - frame.height / 2) * zoom,
              width: frame.width * zoom,
              height: frame.height * zoom,
              rotate: `${frame.angle}deg`,
            }}
          >
            {single === layer ? (
              <>
                {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
                  <span
                    aria-hidden="true"
                    className="wf-canvas-handle"
                    data-corner={corner}
                    key={corner}
                    onPointerDown={(event) => onHandleDown(event, 'scale', layer)}
                  />
                ))}
                <button
                  aria-label="旋转"
                  className="wf-canvas-rotate"
                  data-above={below > canvas.height * zoom ? '' : undefined}
                  onPointerDown={(event) => onHandleDown(event, 'rotate', layer)}
                  tabIndex={-1}
                  type="button"
                >
                  <Icon decorative name="rotate" size="xs" />
                </button>
                {draft?.kind === 'rotate' ? (
                  <span className="wf-canvas-angle">{`${Math.round(frame.angle)}°`}</span>
                ) : null}
              </>
            ) : null}
          </div>
        )
      })}
      {textTarget !== null && textEdit !== undefined ? (
        <CanvasText
          controlRef={controlRef}
          edit={textEdit}
          key={`${textTarget.id}/${textTarget.field}`}
          onClose={closeText}
          onGesture={onGesture}
          onNotice={onNotice}
          target={textTarget}
          zoom={zoom}
        />
      ) : null}
    </div>
  )
}

/**
 * 原地改的一段字：叫什么、一开始的字、不能改时的原因（其它语言下固定的字段），能不能换行（字幕），怎么写进去。
 */
type TextEdit = {
  label: string
  initial: string
  pinned: string | undefined
  multiline: boolean
  save: (text: string) => void
}

/**
 * 预览找到的那段字要怎么改：贴片、场景的文字字段和「属性」里改是同一个写法；字幕和「字幕」页签里改是同一个写法，
 * 一开始是显示着的字（其它语言下没翻的是原文）。都是改这种语言的字。片段、字段不在了时是 undefined。
 */
function textEditOf(
  target: TextTarget,
  clips: readonly FilmClip[],
  {
    catalog,
    locale,
    bindings,
    onText,
    onCaptionText,
  }: Pick<CanvasOverlayProps, 'catalog' | 'locale' | 'bindings' | 'onText' | 'onCaptionText'>,
): TextEdit | undefined {
  const clip = clips.find((each) => each.id === target.id)
  if (clip?.kind === 'caption') {
    const shown = translationOf(locale.values, clip.variable) ?? clip.text
    return {
      label: '字幕',
      initial: shown,
      pinned: undefined,
      multiline: true,
      save: (text) => onCaptionText(clip.id, text, locale.code),
    }
  }
  if (clip?.kind !== 'host') return undefined
  const field = itemNamed(catalog, clip.item)?.variables.find(
    (variable) => variable.id === target.field,
  )
  if (field === undefined) return undefined
  const source = fieldText(clip.values, field)
  const variable = bindings.get(clip.id)?.[target.field]
  return {
    label: field.label,
    initial:
      locale.values === null || variable === undefined
        ? source
        : (translationOf(locale.values, variable) ?? source),
    pinned:
      locale.values !== null && variable === undefined
        ? `「${field.label}」固定${SOURCE_NAME}，所有语言共用；请先在「属性」里点击「随语言」`
        : undefined,
    multiline: false,
    save: (text) => onText(clip.id, field.id, text, locale.code),
  }
}

type CanvasTextProps = {
  edit: TextEdit
  target: TextTarget
  zoom: number
  controlRef: RefObject<PreviewControl | null>
  /** 改完了；`refocus` 时焦点回到画面上（回车、Esc），点到别处时不抢。 */
  onClose: (refocus: boolean) => void
  onGesture: (active: boolean) => void
  onNotice: (message: string) => void
}

/**
 * 原地改字的输入框：盖在预览里藏起来的那段文字上，回车或点到别处时写进去，Esc 放弃。能换行的（字幕）是多行框，
 * Shift+回车换行。不能改的只说明原因。
 */
function CanvasText({
  edit,
  target,
  zoom,
  controlRef,
  onClose,
  onGesture,
  onNotice,
}: CanvasTextProps) {
  const { label, initial, pinned, multiline } = edit
  const [value, setValue] = useState(initial)
  const doneRef = useRef(false)
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  const close = (text: string | null, refocus: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    controlRef.current?.endText(text)
    onGesture(false)
    onClose(refocus)
  }
  const save = (refocus: boolean) => {
    // Esc 放弃以后输入框被拿掉时也会失去焦点，那一下不写
    if (doneRef.current) return
    if (value === initial) {
      close(null, refocus)
      return
    }
    edit.save(value)
    close(value, refocus)
  }

  const open = useEffectEvent(() => {
    if (pinned !== undefined) {
      onNotice(pinned)
      close(null, true)
      return
    }
    onGesture(true)
    inputRef.current?.focus()
    inputRef.current?.select()
  })
  useEffect(() => {
    open()
  }, [])

  useEditorEscape(true, () => close(null, true))

  if (pinned !== undefined) return null
  const { rect, fontSize } = target
  const props = {
    'aria-label': label,
    autoComplete: 'off',
    className: multiline ? 'wf-canvas-text is-multiline' : 'wf-canvas-text',
    onBlur: () => save(false),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(event.target.value),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // 输入法还在拼字时的回车是选字
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
      if (multiline && event.shiftKey) return
      event.preventDefault()
      save(true)
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => event.stopPropagation(),
    ref: inputRef,
    spellCheck: false,
    style: {
      left: rect.x * zoom,
      top: rect.y * zoom,
      minWidth: rect.width * zoom,
      // 字幕的框跟着行数长高
      ...(multiline ? { minHeight: rect.height * zoom } : { height: rect.height * zoom }),
      fontSize: fontSize * zoom,
    },
    value,
  }
  return multiline ? <textarea {...props} rows={1} /> : <input {...props} />
}
