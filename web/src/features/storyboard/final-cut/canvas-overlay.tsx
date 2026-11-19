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
import { hoverOf, hoverProbe, type HoverProbe } from './canvas-hover'
import type { CanvasLayer } from './canvas-layers'
import {
  nudgeOf,
  pickAt,
  resizedSize,
  resizeRatio,
  rotatedAngle,
  type CanvasPick,
  type Frame,
  type Point,
} from './canvas-geometry'
import { snapDrag, type SnapGuides, type SnapRects } from './canvas-snap'
import { drawnFrame, followFrame } from './canvas-visible'
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
  inlineStyleOf,
  layoutSize,
  movedTo,
  movedTranslate,
  rotationStyles,
  rotationTarget,
  scaledStyles,
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

/** 指针在画面上挪动时，最多隔这么久（毫秒）问一次预览页指针下是哪一层。 */
const HOVER_INTERVAL = 80

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
 *   缩放贴片、场景的宿主时 `scale` 是它现在行内写着的 `scale`（别的层是 null）。
 */
type Gesture =
  | {
      kind: 'press'
      start: Point
      last: Point
      shift: boolean
      /** 指针最后一次动时按着 Alt（不吸附）。 */
      alt: boolean
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
      /** 指针最后到的地方、那时按没按着 Alt：吸附用的矩形回来时按它重新摆一次。 */
      last: Point
      alt: boolean
      /** 吸附用的矩形（见 canvas-snap.ts）：开始挪时问预览页，回来之前、量不到时是 null。 */
      snap: SnapRects | null
    }
  | {
      kind: 'resize'
      start: Point
      target: Shown
      size: { width: number; height: number }
      scale: string | null
      released: boolean
    }
  | { kind: 'rotate'; start: Point; target: Shown; rotation: RotationTarget }

/**
 * 拖动中的样子：各层（表里的位置）现在的画面样子；挪、缩放时还有要提交的位移、样式；挪的时候吸附画的参考线
 * （没有时 null）。
 */
type Draft = {
  kind: 'move' | 'resize' | 'rotate'
  frames: ReadonlyMap<number, Frame>
  moves: ReadonlyMap<number, Point>
  styles: Readonly<Record<string, string>> | null
  guides: SnapGuides | null
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
  /** 正在播放：这时指针移上去不框层。 */
  playing: boolean
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
 * 盖在预览画面上的编辑层。画面上每个片段是一层（见预览页的 `pick`）：视频片段、字幕的每一句，贴片、场景整个是它的
 * 宿主（点中它里面画出来的东西都算，透明的、只有铺满的底的地方点到下面）。点一层选中它所在的片段（和时间线上的
 * 选中是同一个）；同一处很快再点一下换成下面一层，
 * 按住 Shift 点是加选。选中的层拖着挪、拖四个角以中心等比缩放、拖旋转把手转（按住 Shift 吸到 15° 的整数倍），焦点
 * 在画面上时方向键挪 1 像素（Shift 10）；写法见 layer-edits.ts，写进这一层所在的文件（宿主写在主文件里它自己身上，
 * 组件文件不动）。锁定的、动画脚本驱动的层不能改，拖的时候说明原因。双击贴片、场景里的文字或字幕原地改。拖动中
 * 预览先跟着摆，松手写进去，算一步撤销。停着时指针移到一层上，在它周围画一圈细框（点下去选中的就是它），能原地
 * 改字的地方（字幕、贴片和场景里绑着文字可填项的元素）光标是输入光标。
 */
export function CanvasOverlay({
  canvas,
  clips,
  layers,
  measures,
  onWatch,
  contentOf,
  frameMs,
  playing,
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
  /** 在画面上选中 `next`。 */
  const select = (next: ReadonlySet<string>) => {
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

  /** 选中的片段画哪一层：片段自己（视频、字幕的一句）或它的宿主。 */
  const watchedOf = (clipId: string): number | undefined => {
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

  const toCanvas = (event: { clientX: number; clientY: number }): Point => {
    const rect = layerRef.current?.getBoundingClientRect()
    const scale = rect === undefined || rect.width === 0 ? 1 : rect.width / canvas.width
    return {
      x: (event.clientX - (rect?.left ?? 0)) / scale,
      y: (event.clientY - (rect?.top ?? 0)) / scale,
    }
  }

  // 悬停：预览页答复的指针下的层，和问的时候画面停在哪一刻、是哪一份 final-cut（变了就不算数，等指针再动）
  const stamp = `${frameMs}/${revision}`
  const stampRef = useRef(stamp)
  useLayoutEffect(() => {
    stampRef.current = stamp
  }, [stamp])
  const [hovering, setHovering] = useState<{
    stack: readonly PickedLayer[]
    stamp: string
  } | null>(null)
  const probeRef = useRef<HoverProbe | null>(null)
  useEffect(() => {
    const probe = hoverProbe(
      (point: Point) => {
        const asked = stampRef.current
        const pick = controlRef.current?.pick(point) ?? Promise.resolve([])
        return pick.then((stack) => ({ stack, stamp: asked }))
      },
      setHovering,
      HOVER_INTERVAL,
    )
    probeRef.current = probe
    return () => {
      probe.stop()
      probeRef.current = null
    }
  }, [controlRef])
  const unhover = () => {
    probeRef.current?.stop()
    setHovering(null)
  }
  /** 字幕的一句自己那一层：在最上面时点一下就选中它（见 `clicked`）。 */
  const isCaption = (layer: CanvasLayer) =>
    clipOf.get(layer.clip)?.kind === 'caption' && layer.element.hfId === layer.clip
  /** 指针下能原地改字：字幕的一句，或者贴片、场景里绑着文字可填项（`field`）的元素。 */
  const isText = (layer: CanvasLayer, field: string | null) => {
    if (isCaption(layer)) return true
    const clip = clipOf.get(layer.clip)
    if (clip?.kind !== 'host' || !layer.host || field === null) return false
    const item = itemNamed(catalog, clip.item)
    return item !== undefined && textFields(item).some((each) => each.id === field)
  }
  const hover =
    hovering === null ||
    hovering.stamp !== stamp ||
    playing ||
    draft !== null ||
    textTarget !== null
      ? null
      : hoverOf(hovering.stack, layers, new Set(shown.map((each) => each.layer.key)), {
          isText,
          winsOnTop: isCaption,
        })

  /** 一层所在的文件里它行内写着的 `property`（CSS 的写法）；没写时是空串。 */
  const inlineOf = (layer: CanvasLayer, property: string) =>
    inlineStyleOf(contentOf(layer.file) ?? '', layer.element.hfId, property)

  /**
   * 一层挪了父元素里的 `delta` 写什么：宿主写它行内的 `translate`，别的层照 SDK `moveElement` 写 `data-x` /
   * `data-y`（见 layer-edits.ts）。
   */
  const movedEdit = (
    layer: CanvasLayer,
    delta: Point,
  ): Pick<LayerEdit, 'move'> & { styles?: Record<string, string> } =>
    layer.host
      ? { styles: { translate: movedTranslate(inlineOf(layer, 'translate'), delta) } }
      : { move: movedTo(layer.element.attributes, delta) }

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
      return layer === undefined ? [] : [{ ...item, layer }]
    })
    const hits = known.map((item) => item.layer.key)
    const selectedKeys = new Set(shown.map((each) => each.layer.key))
    const key = press.shift
      ? (hits[0] ?? null)
      : pickAt(hits, selectedKeys, null, press.start, 0, 0)
    const hit = known.find((item) => item.layer.key === key)
    if (hit === undefined) {
      if (live) gestureRef.current = null
      lastPickRef.current = null
      if (!press.shift && selected.size > 0) select(new Set())
      return undefined
    }
    const { clip } = hit.layer
    const next = press.shift
      ? new Set([...selected, clip])
      : selected.has(clip)
        ? selected
        : new Set([clip])
    select(next)
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
      last: press.last,
      alt: press.alt,
      snap: null,
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
    unhover()
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
      alt: event.altKey,
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
    const captionOnTop = topLayer !== undefined && isCaption(topLayer)
    const key = captionOnTop && top !== undefined && cycled === chosen ? top : cycled
    lastPickRef.current = { point: start, at: now, id: key }
    if (key === chosen || shift) return
    const layer = layers[indexOf.get(key) ?? -1]
    if (layer === undefined) return
    select(new Set([layer.clip]))
  }

  /** 挪的这一下拖到 `point`；`alt` 是按着 Alt（不吸附）。 */
  const dragTo = (gesture: Extract<Gesture, { kind: 'move' }>, point: Point, alt: boolean) => {
    gesture.last = point
    gesture.alt = alt
    const pointer = { x: point.x - gesture.start.x, y: point.y - gesture.start.y }
    if (!gesture.moved) {
      if (gesture.targets.length === 0 || Math.hypot(pointer.x, pointer.y) * zoom < DRAG_SLOP)
        return
      gesture.moved = true
      onGesture(true)
      const refusal = gesture.targets
        .map((target) => refusalOf(target.measure, 'move'))
        .find((reason) => reason !== undefined)
      if (refusal !== undefined) {
        gesture.blocked = true
        onNotice(refusal)
      } else {
        // 在这一下的第一个草稿之前问，量的是它们还在原处的样子；回来以后按指针最后到的地方重新摆一次
        void controlRef.current
          ?.snapRects(gesture.targets.map((target) => target.at))
          .then((rects) => {
            if (gestureRef.current !== gesture || rects === null) return
            gesture.snap = rects
            dragTo(gesture, gesture.last, gesture.alt)
          })
      }
    }
    if (gesture.blocked) return
    const [single, ...others] = gesture.targets
    const { delta, guides } = snapDrag({
      delta: pointer,
      zoom,
      rects: gesture.snap,
      canvas,
      alt,
      angle: single !== undefined && others.length === 0 ? single.measure.frame.angle : null,
    })
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
    showDraft({ kind: 'move', frames, moves, styles: null, guides })
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
        scale: at.layer.host ? inlineOf(at.layer, 'scale') : null,
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
    if (gesture === null) {
      // 在把手上时框选中着的那一层的把手，不问下面是哪一层
      const onHandle =
        event.target instanceof Element && event.target.closest('[data-handle]') !== null
      if (playing || event.pointerType === 'touch' || onHandle) unhover()
      else probeRef.current?.move(toCanvas(event))
      return
    }
    const point = toCanvas(event)
    if (gesture.kind === 'press') {
      gesture.last = point
      gesture.alt = event.altKey
      return
    }
    if (gesture.kind === 'move') {
      dragTo(gesture, point, event.altKey)
      return
    }
    const { at, measure } = gesture.target
    if (gesture.kind === 'resize' && gesture.scale !== null) {
      // 宿主：写 `scale`，绕中心缩，中心不用挪回去
      if (gesture.released) return
      const ratio = resizeRatio(measure.frame, gesture.size, gesture.start, point)
      const styles = scaledStyles(gesture.scale, ratio)
      showDraft({
        kind: 'resize',
        frames: new Map([
          [
            at,
            {
              ...measure.frame,
              width: measure.frame.width * ratio,
              height: measure.frame.height * ratio,
            },
          ],
        ]),
        moves: new Map(),
        styles,
        guides: null,
      })
      void controlRef.current?.draft(at, { x: 0, y: 0 }, cssStyles(styles), false)
      return
    }
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
        guides: null,
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
      guides: null,
    })
  }

  /** 把这次拖动写进去：缩放、转写行内样式，挪见 `movedEdit`。 */
  const commit = (last: Draft, targets: readonly Shown[]) => {
    const edits = targets.flatMap(({ at, layer }): LayerEdit[] => {
      const move = last.moves.get(at)
      const moved =
        move === undefined || (move.x === 0 && move.y === 0) ? null : movedEdit(layer, move)
      const styles = { ...last.styles, ...moved?.styles }
      if (moved?.move === undefined && Object.keys(styles).length === 0) return []
      return [
        {
          file: layer.file,
          element: layer.element.hfId,
          ...(moved?.move === undefined ? {} : { move: moved.move }),
          ...(Object.keys(styles).length === 0 ? {} : { styles }),
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
      dragTo(move, press.last, press.alt)
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
          ...movedEdit(layer, toLocal(measure.parent, step)),
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
      const layer = top === undefined ? undefined : layers[top.layer]
      if (layer === undefined) return
      const clip = clipOf.get(layer.clip)
      if (clip?.kind === 'caption' && clip.id === layer.element.hfId) {
        select(new Set([clip.id]))
        controlRef.current?.editText(clip.id, point, [clip.variable])
        return
      }
      // 贴片、场景：在宿主里找指针下的文字字段
      if (clip?.kind !== 'host' || !layer.host) return
      const item = itemNamed(catalog, clip.item)
      const fields = item === undefined ? [] : textFields(item)
      if (fields.length === 0) return
      select(new Set([clip.id]))
      controlRef.current?.editText(
        clip.id,
        point,
        fields.map((field) => field.id),
      )
    })
  }

  const closeText = (refocus: boolean) => {
    if (refocus) layerRef.current?.focus({ preventScroll: true })
    onTextClose()
  }

  // 只选中一层时才有把手；不能缩放、不能转的不出那个把手
  const single = shown.length === 1 ? shown[0] : undefined
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
      data-hover-text={hover?.text === true ? '' : undefined}
      onDoubleClick={onDoubleClick}
      onLostPointerCapture={onPointerUp}
      onPointerCancel={cancel}
      onPointerDown={onPointerDown}
      onPointerLeave={unhover}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={layerRef}
      role="group"
      tabIndex={-1}
    >
      {hover === null ? null : (
        <div
          aria-hidden="true"
          className="wf-canvas-hover"
          data-testid="canvas-hover"
          style={frameStyle(hover.frame)}
        />
      )}
      {shown.map((each) => {
        const { at, layer, measure } = each
        // 原地改着的字幕：框和输入框叠在一起，不画
        if (textTarget?.id === layer.element.hfId) return null
        // 画在看得见的那一块上；拖动中跟着这一层的草稿走
        const drafted = draft?.frames.get(at)
        const frame =
          drafted === undefined
            ? drawnFrame(measure)
            : followFrame(drawnFrame(measure), measure.frame, drafted)
        const below = (frame.cy + frame.height / 2) * zoom + ROTATE_ROOM
        return (
          <div
            aria-label={`选中：${clipOf.get(layer.clip)?.label ?? layer.clip}`}
            className="wf-canvas-frame"
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
      {draft === null || draft.guides === null ? null : <CanvasGuides guides={draft.guides} />}
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
 * 挪的时候吸附画的参考线（见 canvas-snap.ts）：贯穿画面的对齐线，和标着间距（画布像素）的等距标记。只是看的，
 * 不接收指针。
 */
function CanvasGuides({ guides }: { guides: SnapGuides }) {
  return (
    <div aria-hidden="true" className="wf-canvas-guides">
      {guides.lines.map((line) => (
        <div
          className="wf-canvas-guide"
          data-testid="canvas-guide"
          key={line.key}
          style={{ left: line.left, top: line.top, width: line.width, height: line.height }}
        />
      ))}
      {guides.spacings.map((spacing) => (
        <div
          className="wf-canvas-spacing"
          data-axis={spacing.axis}
          data-testid="canvas-spacing"
          key={spacing.key}
          style={{
            left: spacing.left,
            top: spacing.top,
            width: spacing.width,
            height: spacing.height,
          }}
        >
          <span>{spacing.gap}</span>
        </div>
      ))}
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
