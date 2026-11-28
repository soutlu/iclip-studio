import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react'
import type { HoverProbe } from './canvas-hover'
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
import {
  draftEdits,
  inlineOf,
  movedEdit,
  refusalOf,
  type Draft,
  type Gesture,
  type Shown,
} from './canvas-gesture'
import { snapDrag } from './canvas-snap'
import type { Canvas } from './composition/film'
import { useEditorEscape } from './editor-keys'
import {
  authoredTransform,
  cssStyles,
  layoutSize,
  rotationStyles,
  rotationTarget,
  scaledStyles,
  sizeStyles,
  toLocal,
} from './layer-edits'
import type { PickedLayer, PreviewControl } from './preview-player'
import type { LayerMeasure } from './preview-protocol'
import type { LayerEdit } from './use-film-session'

/** 指针按下后超过该屏幕像素阈值才视为拖拽，否则作为点击处理。 */
const DRAG_SLOP = 3

/** 连续点击循环切换下层图层时，判定为同一点击位置的屏幕像素容差。 */
const SAME_SPOT = 4

/** 元素平移变换定义在外部样式表且无法内联解析时的提示文案。 */
const ROTATE_UNRESOLVED_TEXT = '该片段的变换定义在外部样式中，无法在画面上旋转'

/** 焦点位于画布叠层时的按键回调；成功微调选中图层时返回 `true`。 */
export type CanvasNudge = (event: { key: string; shiftKey: boolean; altKey: boolean }) => boolean

/** 画布手势要用的画布状态与回调；与画布叠层同名属性的含义一致。 */
type CanvasGestureOptions = {
  canvas: Canvas
  layers: readonly CanvasLayer[]
  /** 当前时间点可见并已测量的选中图层。 */
  shown: readonly Shown[]
  /** 只选中一层时的那一层（有缩放、旋转把手）。 */
  single: Shown | undefined
  selected: ReadonlySet<string>
  /** 改选中片段（与当前选中相同时不通知）。 */
  select: (next: ReadonlySet<string>) => void
  /** 画布一像素在屏幕上多宽。 */
  zoom: number
  /** 画布叠层根节点（取焦点、捕获指针）。 */
  layerRef: RefObject<HTMLDivElement | null>
  /** 屏幕坐标换算成画布像素坐标。 */
  toCanvas: (event: { clientX: number; clientY: number }) => Point
  /** 判断是否为单句字幕自身图层。 */
  isCaption: (layer: CanvasLayer) => boolean
  controlRef: RefObject<PreviewControl | null>
  contentOf: (file: string) => string | undefined
  revision: number
  playing: boolean
  /** 停掉悬停探测并清掉预选框。 */
  unhover: () => void
  probeRef: RefObject<HoverProbe | null>
  onEdit: (edits: readonly LayerEdit[]) => void
  onGesture: (active: boolean) => void
  onNotice: (message: string) => void
  nudgeRef: RefObject<CanvasNudge | null>
}

const det = ({ a, b, c, d }: LayerMeasure['parent']) => a * d - b * c

/**
 * 画布上的指针手势与方向键微调：点选与同位置连点换层、拖拽移动（带对齐吸附）、四角缩放、旋转，
 * 拖拽期间驱动预览草稿，松手一次提交；外部变更推进工程修订号、按 Esc 或指针被取消时中止在途拖拽。
 * 返回当前草稿（无拖拽时为 `null`）、取消函数与挂在画布叠层根节点上的指针处理器。
 */
export function useCanvasGesture({
  canvas,
  layers,
  shown,
  single,
  selected,
  select,
  zoom,
  layerRef,
  toCanvas,
  isCaption,
  controlRef,
  contentOf,
  revision,
  playing,
  unhover,
  probeRef,
  onEdit,
  onGesture,
  onNotice,
  nudgeRef,
}: CanvasGestureOptions) {
  const gestureRef = useRef<Gesture | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  // 最后一次拖到的样子：松手时可能还没重画
  const draftRef = useRef<Draft | null>(null)
  /** 缩放时最近一次拖动的答复记进 `draftRef` 以后才完。 */
  const pinRef = useRef<Promise<void>>(Promise.resolve())
  const lastPickRef = useRef<CanvasPick | null>(null)

  const indexOf = new Map(layers.map((layer, at) => [layer.key, at]))

  const showDraft = (next: Draft | null) => {
    draftRef.current = next
    setDraft(next)
  }

  const finish = () => {
    gestureRef.current = null
    showDraft(null)
    onGesture(false)
  }

  /** 取消在途拖拽并通知预览页还原 DOM 样式。 */
  const cancel = () => {
    for (const at of draftRef.current?.frames.keys() ?? []) controlRef.current?.draftEnd(at, false)
    finish()
  }

  // 外部撤销或编辑推进工程修订号时，基于旧状态起算的在途拖拽立即作废
  const cancelStale = useEffectEvent(() => {
    if (gestureRef.current !== null) cancel()
  })
  useEffect(() => {
    cancelStale()
  }, [revision])

  useEditorEscape(draft !== null, cancel)

  /** 处理按下位置的异步拾取响应：更新选中片段并构造后续 `move` 手势状态（无需继续时返回 `undefined`）。 */
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
    // 合并多选中的其余可见图层与当前命中的图层，作为共同拖拽目标
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
  /** 拾取响应异步到达时始终基于最新渲染态处理选中关系。 */
  const pressedRef = useRef<
    ((press: Extract<Gesture, { kind: 'press' }>, stack: readonly PickedLayer[]) => void) | null
  >(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current
    // 前一次快速点击已松开但仍在等待拾取回执时，允许紧接着按下触发连续换层
    const waiting = current?.kind === 'press' && current.released !== null
    if (event.button !== 0 || (current !== null && !waiting)) return
    unhover()
    // 命中单选控制柄时进入缩放或旋转手势
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
   * 未发生拖拽即松手时结算点击：同位置快速连点按 `pickAt` 切换下层；
   * 若最顶层为单句字幕且未触发连点换层，单击直接切换选中该字幕（按下阶段保留底层已选片段仅用于支持按住直拖）。
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

  /** 更新移动拖拽草稿至 `point`（`alt` 为真时禁用对齐吸附）。 */
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
        // 在发送首个移动草稿前请求初始位置的吸附矩形，返回后按最新指针坐标重算对齐位置
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
        scale: at.layer.host ? inlineOf(contentOf, at.layer, 'scale') : null,
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
    // 将指针捕获在画布叠层根节点上，确保移出控制柄后仍可持续接收移动事件
    layerRef.current?.setPointerCapture(event.pointerId)
    onGesture(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture === null) {
      // 悬停在控制柄上时不触发底层图层拾取
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
      // 元素/模板宿主直接写 `scale` 围绕中心等比缩放，无需额外补偿中心偏移
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

  /** 将最终草稿提交至工程会话（变更内容见 `draftEdits`）。 */
  const commit = (last: Draft, targets: readonly Shown[]) => {
    const edits = draftEdits(contentOf, last, targets)
    for (const { at } of targets) controlRef.current?.draftEnd(at, edits.length > 0)
    if (edits.length > 0) onEdit(edits)
  }

  /**
   * 拾取回执到达后推进手势：若仍处于按下态则补放积压指针位移；
   * 若回执到达前已松手，则按是否发生过有效拖拽分别提交变更或结算为单击。
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
          ...movedEdit(contentOf, layer, toLocal(measure.parent, step)),
        })),
      )
      return true
    }
    return () => {
      nudgeRef.current = null
    }
  })

  return { draft, cancel, onPointerDown, onPointerMove, onPointerUp }
}
