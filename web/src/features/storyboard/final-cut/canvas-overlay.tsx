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
import type { CanvasLayer } from './canvas-layers'
import {
  frameContains,
  nudgeOf,
  pickAt,
  resizedSize,
  rotatedAngle,
  type CanvasPick,
  type Frame,
  type Point,
} from './canvas-geometry'
import type { CaptionTextChange } from './captions-tab'
import type { ComponentCatalog } from './composition/catalog'
import { itemNamed, type Canvas, type FilmClip } from './composition/film'
import { fieldText, textFields, type LocaleBindings } from './composition/locale-text'
import type { ItemTextChange } from './component-texts'
import { useEditorEscape } from './editor-keys'
import { LayerRefusal, REFUSAL_TEXT, type Gesture as Ability } from './layer-abilities'
import {
  authoredTransform,
  cssStyles,
  layoutSize,
  movedTo,
  rotationStyles,
  rotationTarget,
  sizeStyles,
  toLocal,
  type RotationTarget,
} from './layer-edits'
import { SOURCE_NAME, translationOf, type ShownLocale } from './locales'
import type { PickedLayer, PreviewControl, TextTarget } from './preview-player'
import type { LayerMeasure } from './preview-protocol'
import type { LayerEdit } from './use-film-session'

/** 指针按下后挪过这么多屏幕像素才算拖动，不然只是点选。 */
const DRAG_SLOP = 3

/** 同一处再点一次换下一层时，两次离得多近（屏幕像素）算同一处。 */
const SAME_SPOT = 4

/** 旋转把手离选中框底边的空间（屏幕像素）：画面下面放不下时放到框上面。 */
const ROTATE_ROOM = 32

/** 转的时候元素的变换写在样式表里、又找不到时说的话。 */
export const ROTATE_UNRESOLVED_TEXT = '这一层的变换写在组件的样式里，暂时不能在画面上转'

/** 画面上显示着的一层：表里的位置和这一层，量出来的样子。 */
type Shown = { at: number; layer: CanvasLayer; measure: LayerMeasure }

/**
 * 按下以后的这一下：
 * - `press`：在等预览页答复按下处有哪些层（`stack` 答复后才有），`last` 是指针最后到的地方；
 * - `move`：挪选中的层（`targets` 是要挪的、按下时的样子），`blocked` 时不挪（已经说过原因）；
 * - `resize`、`rotate`：拖一层的把手；缩放松手后（`released`）还要等预览页答复最后一次把中心挪回原处的位移。
 */
type Gesture =
  | {
      kind: 'press'
      start: Point
      last: Point
      shift: boolean
      released: number | null
    }
  | {
      kind: 'move'
      start: Point
      targets: readonly Shown[]
      moved: boolean
      blocked: boolean
      hits: readonly string[]
      picked: string
      shift: boolean
    }
  | {
      kind: 'resize'
      start: Point
      target: Shown
      size: { width: number; height: number }
      released: boolean
    }
  | { kind: 'rotate'; start: Point; target: Shown; rotation: RotationTarget }

/** 拖动中的样子：各层（表里的位置）现在的画面样子；挪、缩放时还有要提交的位移、样式。 */
type Draft = {
  kind: 'move' | 'resize' | 'rotate'
  frames: ReadonlyMap<number, Frame>
  moves: ReadonlyMap<number, Point>
  styles: Readonly<Record<string, string>> | null
}

type CanvasOverlayProps = {
  canvas: Canvas
  /** final-cut 的片段，按文件里的先后。 */
  clips: readonly FilmClip[]
  /** 画面上的层和宿主（见 canvas-layers.ts），和交给预览的那张表一样。 */
  layers: readonly CanvasLayer[]
  /** 预览量出来的层（表里的位置 → 量出来的样子），只有 `onWatch` 要过的。 */
  measures: ReadonlyMap<number, LayerMeasure>
  /** 编辑层要预览量哪几层（表里的位置）。 */
  onWatch: (layers: readonly number[]) => void
  /** 工程里一个文件现在的内容（相对工程根）；没打开着时是 undefined。 */
  contentOf: (file: string) => string | undefined
  /** 画面停在第几毫秒（显示着哪些片段按它算）。 */
  frameMs: number
  /** final-cut 换了一份时变；拖到一半换了就取消这次拖动。 */
  revision: number
  selected: ReadonlySet<string>
  controlRef: RefObject<PreviewControl | null>
  onSelect: (ids: ReadonlySet<string>) => void
  /** 松手、按方向键时把改动写进各层所在的文件（一步撤销）。 */
  onEdit: (edits: readonly LayerEdit[]) => void
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
  /** 编辑层放进这里一个处理方向键的函数：挪了选中的层时答 true（这一下用掉了）。 */
  nudgeRef: RefObject<CanvasNudge | null>
}

/** 焦点在画面上时按的一个键；挪了画面上选中的层时答 true。 */
export type CanvasNudge = (event: { key: string; shiftKey: boolean; altKey: boolean }) => boolean

/** 一层能不能这样改；不能时给人看的原因。 */
const refusalOf = (measure: LayerMeasure, ability: Ability): string | undefined => {
  const allowed =
    ability === 'move' ? measure.move : ability === 'resize' ? measure.resize : measure.turn
  if (allowed) return undefined
  const refusal = measure.refusal === LayerRefusal.none ? LayerRefusal.animated : measure.refusal
  return REFUSAL_TEXT[refusal as Exclude<LayerRefusal, 0>]
}

const det = ({ a, b, c, d }: LayerMeasure['parent']) => a * d - b * c

/**
 * 这一层叫什么：视频片段、字幕、宿主用片段的名字；组件里的层是「片段名 · id 或 class」，同名的第几个大于 1 时带上。
 */
const layerName = (layer: CanvasLayer, clip: FilmClip | undefined): string => {
  const label = clip?.label ?? layer.clip
  if (layer.host || layer.element.hfId === layer.clip) return label
  const name = layer.selector.replace(/^[#.]/, '').replace(/^\[[^=]+="(.*)"\]$/, '$1')
  return `${label} · ${layer.index > 0 ? `${name} ${layer.index + 1}` : name}`
}

/**
 * 盖在预览画面上的编辑层。点中的规则照运行库（见预览页的 `pick`）：宿主、铺满画面的容器、空容器、不接收指针的
 * 都跳过，点到的是里面的层（视频片段、字幕的每一句、组件或块里的层），选中它所在的片段（和时间线上的选中是同一个）；
 * 同一处很快再点一下换成下面一层，按住 Shift 点是加选。选中的层拖着挪、拖四个角以中心等比缩放、拖旋转把手转（按住
 * Shift 吸到 15° 的整数倍），焦点在画面上时方向键挪 1 像素（Shift 10）；写法见 layer-edits.ts，写进这一层所在的
 * 文件。时间线上选中组件或块的片段时画面上框住宿主、没有把手，宿主本身不能改；锁定的、脚本生成的、动画脚本驱动的层
 * 也不能改，拖的时候说明原因。双击贴片、场景里的文字或字幕原地改。拖动中预览先跟着摆，松手写进去，算一步撤销。
 */
export function CanvasOverlay({
  canvas,
  clips,
  layers,
  measures,
  onWatch,
  contentOf,
  frameMs,
  revision,
  selected,
  controlRef,
  onSelect,
  onEdit,
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
  /** 缩放时最近一次拖动的答复记进 `draftRef` 以后才完。 */
  const pinRef = useRef<Promise<void>>(Promise.resolve())
  const lastPickRef = useRef<CanvasPick | null>(null)
  // 在画面上点中的层：片段 → 层（表里的 key），和点中时的选中；点中的是脚本生成的层（表里没有）时只框住它。
  // 选中换成别的（时间线上点的）以后不再算数，画回片段自己（视频、字幕）或它的宿主
  const [pickedState, setPickedState] = useState<{
    selection: string
    layers: ReadonlyMap<string, string>
    generated: { clip: string; measure: LayerMeasure } | null
  }>(() => ({ selection: '', layers: new Map(), generated: null }))
  const selectionKey = (ids: ReadonlySet<string>) => [...ids].toSorted().join('\n')
  const selectedKey = selectionKey(selected)
  const current = pickedState.selection === selectedKey
  const picked = current ? pickedState.layers : new Map<string, string>()
  const generated = current ? pickedState.generated : null
  /** 在画面上选中 `next`：点中了 `clip` 的 `layer`（脚本生成的层是 `generated`）。 */
  const select = (
    next: ReadonlySet<string>,
    choice:
      | { clip: string; layer: string }
      | { generated: { clip: string; measure: LayerMeasure } }
      | null,
  ) => {
    setPickedState({
      selection: selectionKey(next),
      layers:
        choice !== null && 'layer' in choice
          ? new Map(picked).set(choice.clip, choice.layer)
          : picked,
      generated: choice !== null && 'generated' in choice ? choice.generated : null,
    })
    if (next !== selected) onSelect(next)
  }

  const indexOf = new Map(layers.map((layer, at) => [layer.key, at]))
  const clipOf = new Map(clips.map((clip) => [clip.id, clip]))
  const shownAt = (clipId: string) => {
    const clip = clipOf.get(clipId)
    return (
      clip !== undefined &&
      !clip.hidden &&
      clip.start <= frameMs &&
      frameMs < clip.start + clip.duration
    )
  }

  /** 选中的片段画哪一层：点中过的那一层；不然是片段自己（视频、字幕）或它的宿主。 */
  const watchedOf = (clipId: string): number | undefined => {
    const key = picked.get(clipId)
    const chosen = key === undefined ? undefined : indexOf.get(key)
    if (chosen !== undefined) return chosen
    const own = layers.findIndex(
      (layer) => layer.clip === clipId && (layer.host || layer.element.hfId === clipId),
    )
    return own < 0 ? undefined : own
  }
  const watching = [...selected].flatMap((clipId) => {
    const at = watchedOf(clipId)
    return at === undefined ? [] : [at]
  })
  const watchKey = watching.join(',')
  const watch = useEffectEvent((next: readonly number[]) => onWatch(next))
  useEffect(() => {
    watch(watchKey === '' ? [] : watchKey.split(',').map(Number))
  }, [watchKey])

  const shown: Shown[] = watching.flatMap((at) => {
    const layer = layers[at]
    const measure = measures.get(at)
    return layer === undefined || measure === undefined || !shownAt(layer.clip)
      ? []
      : [{ at, layer, measure }]
  })
  const generatedShown =
    generated !== null && selected.has(generated.clip) && shownAt(generated.clip) ? generated : null

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

  /** 取消这次拖动：预览里摆回拖动开始时的样子。 */
  const cancel = () => {
    for (const at of draftRef.current?.frames.keys() ?? []) controlRef.current?.draftEnd(at, false)
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

  /** 按下处的层答复回来：选中，答复接着要走的这一下（见 `proceed`）；不用再走时是 undefined。 */
  const pressed = (
    press: Extract<Gesture, { kind: 'press' }>,
    stack: readonly PickedLayer[],
  ): Extract<Gesture, { kind: 'move' }> | undefined => {
    const live = gestureRef.current === press
    if (!live && press.released === null) return
    const known = stack.flatMap((item) => {
      const layer = layers[item.layer]
      return item.layer < 0 || layer === undefined || layer.host ? [] : [{ ...item, layer }]
    })
    const hits = known.map((item) => item.layer.key)
    const selectedKeys = new Set(shown.map((each) => each.layer.key))
    const key = press.shift
      ? (hits[0] ?? null)
      : pickAt(hits, selectedKeys, null, press.start, 0, 0)
    const hit = known.find((item) => item.layer.key === key)
    const [top] = stack
    const owner = top === undefined ? undefined : layers[top.owner]
    // 最上面是脚本生成的层（指针下没有选中着的层时）：框住它，选中它所在的片段；拖的时候说明不能改
    if (
      top !== undefined &&
      top.layer < 0 &&
      owner !== undefined &&
      !hits.some((each) => selectedKeys.has(each))
    ) {
      select(new Set([owner.clip]), { generated: { clip: owner.clip, measure: top.measure } })
      const move: Extract<Gesture, { kind: 'move' }> = {
        kind: 'move',
        start: press.start,
        targets: [{ at: -1, layer: owner, measure: top.measure }],
        moved: false,
        blocked: false,
        hits: [],
        picked: '',
        shift: press.shift,
      }
      return move
    }
    // 按在框着的宿主上、没按中它里面的层：拖的时候说明要选里面的层；没拖是一次点选，照常选中指针下的层
    const host = shown.find(
      (each) => each.layer.host && frameContains(each.measure.frame, press.start),
    )
    if (host !== undefined && hit?.layer.clip !== host.layer.clip) {
      const move: Extract<Gesture, { kind: 'move' }> = {
        kind: 'move',
        start: press.start,
        targets: [host],
        moved: false,
        blocked: false,
        hits,
        picked: host.layer.key,
        shift: press.shift,
      }
      return move
    }
    if (hit === undefined) {
      if (live) gestureRef.current = null
      lastPickRef.current = null
      if (!press.shift && selected.size > 0) select(new Set(), null)
      return undefined
    }
    const { clip } = hit.layer
    const next = press.shift
      ? new Set([...selected, clip])
      : selected.has(clip) && picked.get(clip) === hit.layer.key
        ? selected
        : new Set([clip])
    select(next, { clip, layer: hit.layer.key })
    // 一起挪的：选中的别的片段画着的层，和点中的这一层
    const others = shown.filter((each) => next.has(each.layer.clip) && each.layer.clip !== clip)
    const targets = [
      ...others,
      { at: indexOf.get(hit.layer.key) ?? -1, layer: hit.layer, measure: hit.measure },
    ]
    const move: Extract<Gesture, { kind: 'move' }> = {
      kind: 'move',
      start: press.start,
      targets: targets.filter((target) => target.at >= 0),
      moved: false,
      blocked: false,
      hits,
      picked: hit.layer.key,
      shift: press.shift,
    }
    return move
  }
  /** 答复是异步回来的：照最新一次渲染的选中算（见下面的 effect）。 */
  const pressedRef = useRef<
    ((press: Extract<Gesture, { kind: 'press' }>, stack: readonly PickedLayer[]) => void) | null
  >(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current
    // 前一下已经松开、还在等答复时可以再按（很快连点）
    const waiting = current?.kind === 'press' && current.released !== null
    if (event.button !== 0 || (current !== null && !waiting)) return
    // 按在把手上（只有一层选中时才有）
    const handle =
      event.target instanceof Element
        ? event.target.closest('[data-handle]')?.getAttribute('data-handle')
        : undefined
    if (single !== undefined && (handle === 'resize' || handle === 'rotate')) {
      onHandleDown(event, handle, single)
      return
    }
    layerRef.current?.focus({ preventScroll: true })
    const point = toCanvas(event)
    const press: Extract<Gesture, { kind: 'press' }> = {
      kind: 'press',
      start: point,
      last: point,
      shift: event.shiftKey,
      released: null,
    }
    gestureRef.current = press
    event.currentTarget.setPointerCapture(event.pointerId)
    const control = controlRef.current
    if (control === null) {
      gestureRef.current = null
      return
    }
    void control.pick(point).then((stack) => pressedRef.current?.(press, stack))
  }

  /**
   * 没拖动就松手：是一次点选。同一处很快再点一次时换成下一层（见 `pickAt`）。字幕在最上面时点一下就选中它，不让压在
   * 下面、选中着的层留着（按下时留着它，是为了按住能拖）。
   */
  const clicked = (gesture: Extract<Gesture, { kind: 'move' }>, now: number) => {
    const { hits, picked: chosen, start, shift } = gesture
    const cycled =
      pickAt(hits, new Set([chosen]), lastPickRef.current, start, now, SAME_SPOT / (zoom || 1)) ??
      chosen
    const [top] = hits
    const topLayer = top === undefined ? undefined : layers[indexOf.get(top) ?? -1]
    const captionOnTop =
      topLayer !== undefined &&
      clipOf.get(topLayer.clip)?.kind === 'caption' &&
      topLayer.element.hfId === topLayer.clip
    const key = captionOnTop && top !== undefined && cycled === chosen ? top : cycled
    lastPickRef.current = { point: start, at: now, id: key }
    if (key === chosen || shift) return
    const layer = layers[indexOf.get(key) ?? -1]
    if (layer === undefined) return
    select(new Set([layer.clip]), { clip: layer.clip, layer: key })
  }

  /** 挪的这一下拖到 `point`。 */
  const dragTo = (gesture: Extract<Gesture, { kind: 'move' }>, point: Point) => {
    const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y }
    if (!gesture.moved) {
      if (gesture.targets.length === 0 || Math.hypot(delta.x, delta.y) * zoom < DRAG_SLOP) return
      gesture.moved = true
      onGesture(true)
      const refusal = gesture.targets
        .map((target) => refusalOf(target.measure, 'move'))
        .find((reason) => reason !== undefined)
      if (refusal !== undefined) {
        gesture.blocked = true
        onNotice(refusal)
      }
    }
    if (gesture.blocked) return
    const frames = new Map<number, Frame>()
    const moves = new Map<number, Point>()
    for (const { at, measure } of gesture.targets) {
      const local = toLocal(measure.parent, delta)
      moves.set(at, local)
      frames.set(at, {
        ...measure.frame,
        cx: measure.frame.cx + delta.x,
        cy: measure.frame.cy + delta.y,
      })
      void controlRef.current?.draft(at, local, {}, false)
    }
    showDraft({ kind: 'move', frames, moves, styles: null })
  }

  const onHandleDown = (event: PointerEvent<HTMLElement>, kind: 'resize' | 'rotate', at: Shown) => {
    if (event.button !== 0 || gestureRef.current !== null) return
    event.stopPropagation()
    event.preventDefault()
    layerRef.current?.focus({ preventScroll: true })
    const refusal = refusalOf(at.measure, kind)
    if (refusal !== undefined) {
      onNotice(refusal)
      return
    }
    const start = toCanvas(event)
    if (kind === 'resize') {
      gestureRef.current = {
        kind,
        start,
        target: at,
        size: { width: at.measure.width, height: at.measure.height },
        released: false,
      }
    } else {
      const { measure, layer } = at
      const content = measure.translating ? contentOf(layer.file) : undefined
      const rotation = rotationTarget(
        measure.translating,
        content === undefined ? undefined : authoredTransform(content, layer.element.hfId),
        measure.rotate,
      )
      if (rotation === null) {
        onNotice(ROTATE_UNRESOLVED_TEXT)
        return
      }
      gestureRef.current = { kind, start, target: at, rotation }
    }
    // 指针交给编辑层，拖出把手以后照样收得到
    layerRef.current?.setPointerCapture(event.pointerId)
    onGesture(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture === null) return
    const point = toCanvas(event)
    if (gesture.kind === 'press') {
      gesture.last = point
      return
    }
    if (gesture.kind === 'move') {
      dragTo(gesture, point)
      return
    }
    const { at, measure } = gesture.target
    if (gesture.kind === 'resize') {
      if (gesture.released) return
      const size = layoutSize(resizedSize(measure.frame, gesture.size, gesture.start, point))
      const styles = sizeStyles(size, measure.flex, measure.inline)
      const frame = {
        ...measure.frame,
        width: (measure.frame.width * size.width) / Math.max(gesture.size.width, 1),
        height: (measure.frame.height * size.height) / Math.max(gesture.size.height, 1),
      }
      const next: Draft = {
        kind: 'resize',
        frames: new Map([[at, frame]]),
        moves: new Map([[at, { x: 0, y: 0 }]]),
        styles,
      }
      showDraft(next)
      const reply = controlRef.current?.draft(at, { x: 0, y: 0 }, cssStyles(styles), true)
      pinRef.current = (reply ?? Promise.resolve(null)).then((moved) => {
        // 只记这一次拖动里最新的那份
        if (moved !== null && draftRef.current === next)
          draftRef.current = { ...next, moves: new Map([[at, moved]]) }
      })
      return
    }
    const center = { x: measure.frame.cx, y: measure.frame.cy }
    const angle = rotatedAngle(center, measure.frame.angle, gesture.start, point, event.shiftKey)
    const sign = det(measure.parent) < 0 ? -1 : 1
    const turn = gesture.rotation.turn + (angle - measure.frame.angle) * sign
    const styles = rotationStyles(gesture.rotation, turn, measure.inline)
    void controlRef.current?.draft(at, { x: 0, y: 0 }, cssStyles(styles), false)
    showDraft({
      kind: 'rotate',
      frames: new Map([[at, { ...measure.frame, angle }]]),
      moves: new Map(),
      styles,
    })
  }

  /** 把这次拖动写进去：挪的位移照 SDK `moveElement` 写，缩放、转写行内样式。 */
  const commit = (last: Draft, targets: readonly Shown[]) => {
    const edits = targets.flatMap(({ at, layer }): LayerEdit[] => {
      const move = last.moves.get(at)
      const moved =
        move === undefined || (move.x === 0 && move.y === 0)
          ? undefined
          : movedTo(layer.element.attributes, move)
      if (moved === undefined && last.styles === null) return []
      return [
        {
          file: layer.file,
          element: layer.element.hfId,
          ...(moved === undefined ? {} : { move: moved }),
          ...(last.styles === null ? {} : { styles: last.styles }),
        },
      ]
    })
    for (const { at } of targets) controlRef.current?.draftEnd(at, edits.length > 0)
    if (edits.length > 0) onEdit(edits)
  }

  /**
   * 按下的这一下照 `move` 接着走：还按着就开始挪；答复回来前已经松开了，拖过了照拖完提交，没拖是一次点选。
   * `live` 是它还是眼下这一下（松开后又按了一下时，前一下只算点选）。
   */
  const proceed = (
    press: Extract<Gesture, { kind: 'press' }>,
    move: Extract<Gesture, { kind: 'move' }>,
    live: boolean,
  ) => {
    if (live) {
      gestureRef.current = move
      dragTo(move, press.last)
    }
    if (press.released === null) return
    if (live) gestureRef.current = null
    if (!move.moved) {
      clicked(move, press.released)
      return
    }
    const last = draftRef.current
    if (last !== null) commit(last, move.targets)
    finish()
  }
  useEffect(() => {
    pressedRef.current = (press, stack) => {
      const live = gestureRef.current === press
      const move = pressed(press, stack)
      if (move !== undefined) proceed(press, move, live)
    }
  })

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture === null) return
    if (gesture.kind === 'press') {
      // 还在等预览页答复：答复回来时当一次点选
      gesture.released = event.timeStamp
      return
    }
    if (gesture.kind === 'move' && !gesture.moved) {
      gestureRef.current = null
      clicked(gesture, event.timeStamp)
      return
    }
    if (gesture.kind === 'resize') {
      // 等最后一次拖动的答复（中心挪回原处的位移）回来再提交；这中间取消了（`cancel`）就不提交
      if (gesture.released) return
      gesture.released = true
      void pinRef.current.then(() => {
        if (gestureRef.current !== gesture) return
        const last = draftRef.current
        if (last !== null) commit(last, [gesture.target])
        finish()
      })
      return
    }
    const last = draftRef.current
    const targets = gesture.kind === 'move' ? gesture.targets : [gesture.target]
    if (last !== null) commit(last, targets)
    finish()
  }

  // 焦点在画面上时按的方向键：挪画面上选中的层（编辑器的快捷键处理经 `nudgeRef` 调）
  useEffect(() => {
    nudgeRef.current = (event) => {
      if (gestureRef.current !== null || event.altKey) return false
      const step = nudgeOf(event.key, event.shiftKey)
      if (step === null || shown.length === 0) return false
      const refusal = shown
        .map((each) => refusalOf(each.measure, 'move'))
        .find((reason) => reason !== undefined)
      if (refusal !== undefined) {
        onNotice(refusal)
        return true
      }
      onEdit(
        shown.map(({ layer, measure }) => ({
          file: layer.file,
          element: layer.element.hfId,
          move: movedTo(layer.element.attributes, toLocal(measure.parent, step)),
        })),
      )
      return true
    }
    return () => {
      nudgeRef.current = null
    }
  })

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const point = toCanvas(event)
    void controlRef.current?.pick(point).then(([top]) => {
      if (top === undefined) return
      const layer = layers[top.layer]
      const owner = layers[top.owner]
      const caption = layer === undefined ? undefined : clipOf.get(layer.clip)
      if (caption?.kind === 'caption' && caption.id === layer?.element.hfId) {
        select(new Set([caption.id]), null)
        controlRef.current?.editText(caption.id, point, [caption.variable])
        return
      }
      const host = owner === undefined ? undefined : clipOf.get(owner.clip)
      if (host?.kind !== 'host') return
      const item = itemNamed(catalog, host.item)
      const fields = item === undefined ? [] : textFields(item)
      if (fields.length === 0) return
      select(new Set([host.id]), null)
      controlRef.current?.editText(
        host.id,
        point,
        fields.map((field) => field.id),
      )
    })
  }

  const closeText = (refocus: boolean) => {
    if (refocus) layerRef.current?.focus({ preventScroll: true })
    onTextClose()
  }

  // 只选中一层、它不是宿主时才有把手；不能缩放、不能转的不出那个把手
  const single = shown.length === 1 && shown[0]?.layer.host === false ? shown[0] : undefined
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

  const frameStyle = (frame: Frame) => ({
    left: (frame.cx - frame.width / 2) * zoom,
    top: (frame.cy - frame.height / 2) * zoom,
    width: frame.width * zoom,
    height: frame.height * zoom,
    rotate: `${frame.angle}deg`,
  })
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
      {shown.map((each) => {
        const { at, layer, measure } = each
        // 原地改着的字幕：框和输入框叠在一起，不画
        if (textTarget?.id === layer.element.hfId) return null
        const frame = draft?.frames.get(at) ?? measure.frame
        const below = (frame.cy + frame.height / 2) * zoom + ROTATE_ROOM
        return (
          <div
            aria-label={`选中：${layerName(layer, clipOf.get(layer.clip))}`}
            className="wf-canvas-frame"
            data-host={layer.host ? '' : undefined}
            key={layer.key}
            role="img"
            style={frameStyle(frame)}
          >
            {single === each ? (
              <>
                {measure.resize
                  ? (['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
                      <span
                        aria-hidden="true"
                        className="wf-canvas-handle"
                        data-corner={corner}
                        data-handle="resize"
                        key={corner}
                      />
                    ))
                  : null}
                {measure.turn ? (
                  <button
                    aria-label="旋转"
                    className="wf-canvas-rotate"
                    data-above={below > canvas.height * zoom ? '' : undefined}
                    data-handle="rotate"
                    tabIndex={-1}
                    type="button"
                  >
                    <Icon decorative name="rotate" size="xs" />
                  </button>
                ) : null}
                {draft?.kind === 'rotate' ? (
                  <span className="wf-canvas-angle">{`${Math.round(frame.angle)}°`}</span>
                ) : null}
              </>
            ) : null}
          </div>
        )
      })}
      {generatedShown === null ? null : (
        <div
          aria-label="选中：脚本生成的层"
          className="wf-canvas-frame"
          role="img"
          style={frameStyle(generatedShown.measure.frame)}
        />
      )}
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
