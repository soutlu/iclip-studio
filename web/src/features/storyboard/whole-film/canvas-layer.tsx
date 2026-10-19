import type { EditOp, PreviewAdapter } from '@hyperframes/sdk'
import { createIframePreviewAdapter } from '@hyperframes/sdk/adapters/iframe'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { cn } from '@/shared/lib/utils'
import { DRAG_THRESHOLD } from '../editing/timeline-drag'
import { canvasDelta, dragTargetOf, positionOf, snapDrag } from './canvas-drag'
import { captionKey, hfIdOnScreen, selectionOfHfId } from './canvas-targets'
import { EDITABLE_TEXT, startTextEdit } from './canvas-text-edit'
import type { PlacedCaption } from './composition/captions'
import type { WholeFilmDraft } from './editing/draft'
import type { Selection } from './film-tracks'
import { hitAt, ownerOf, paintedBounds, painterAt, stackAt, type Box } from './painted-bounds'

/** 组件的一项文字在画面上改完：哪一块的哪一项、改成什么、改之前画面上的字 */
export type ComponentText = { id: string; variable: string; text: string; shown: string }

type CanvasLayerProps = {
  /** 正在显示的合成页；没有时这一层什么也不做 */
  iframe: HTMLIFrameElement | null
  /** 画布尺寸（合成页文档的宽高） */
  canvas: { width: number; height: number }
  draft: WholeFilmDraft
  captions: readonly PlacedCaption[]
  playheadMs: number
  selection: Selection
  /** 拖动时吸附画面的中线与四边（编辑器的「吸附」开关） */
  snap: boolean
  onSelect: (selection: Selection) => void
  /** 在画面上按下时先暂停 */
  onPause: () => void
  /** 改字时放进字幕里的整句：改过的字或识别结果 */
  sentenceText: (caption: PlacedCaption) => string
  /** 改完一句字幕；返回写没写进草稿 */
  onCaptionText: (caption: PlacedCaption, text: string) => boolean
  /** 改完组件的一项文字；返回写没写进草稿 */
  onComponentText: (change: ComponentText) => boolean
  /** 拖完松手时 SDK 交回的移动操作；返回写没写进草稿 */
  onMove: (op: EditOp) => boolean
}

type ContentWindow = Window & typeof globalThis

/** 合成页的文档、窗口与它在屏幕上的位置、缩放（iframe 宽 / 画布宽） */
const frameGeometry = (iframe: HTMLIFrameElement | null, canvasWidth: number) => {
  const doc = iframe?.contentDocument
  const win = iframe?.contentWindow as ContentWindow | null | undefined
  if (iframe == null || doc == null || win == null) return undefined
  const rect = iframe.getBoundingClientRect()
  const scale = rect.width / canvasWidth
  if (!(scale > 0)) return undefined
  return { doc, win, rect, scale }
}

type GsapWindow = { gsap?: { getProperty?: (target: Element, property: string) => unknown } }

/**
 * 拖动前让合成页里的 GSAP 先解析一次这个元素的 transform，同 HyperFrames 运行时写位置之前的
 * primeGsapTransformCache。SDK 的 applyDraft 先写 `translate`、松手时才第一次让 GSAP 解析，GSAP 会把
 * 已有的 `translate` 折进 `transform`，换页之前元素挪开两倍的距离；先解析过就不会。
 */
function primeTransform(iframe: HTMLIFrameElement | null, hfId: string) {
  const element = iframe?.contentDocument?.querySelector(`[data-hf-id="${CSS.escape(hfId)}"]`)
  if (element == null) return
  ;(iframe?.contentWindow as GsapWindow | null | undefined)?.gsap?.getProperty?.(element, 'x')
}

/** 播放器元素：iframe 在它的 shadow DOM 里 */
const playerOf = (iframe: HTMLIFrameElement) => {
  const root = iframe.getRootNode()
  return root instanceof ShadowRoot ? root.host : undefined
}

/** 画面上量出来的一块：都在这一层自己的坐标里（相对这一层的左上角，屏幕像素） */
type Measured = {
  /** 这一层在屏幕上的范围 */
  area: DOMRect
  /** 画面（iframe）的范围 */
  frame: Box
  /** 这一块画出来的部分 */
  box: Box
  /** iframe 宽 / 画布宽 */
  scale: number
}

/** 进行中的拖动；没超过阈值时 moved 为 false，松手只算一次点击 */
type Drag = {
  pointerId: number
  /** 拖哪个元素（data-hf-id）：特效块的草稿 id，或整片字幕 */
  target: string
  /** 选中框框着的那一块（字幕是选中的那一句） */
  hfId: string
  originX: number
  originY: number
  /** 按下时草稿里记着的位置 */
  from: { x: number; y: number }
  moved: boolean
  /** 超过阈值时量一次；拖动中不再量，选中框按同样的位移挪 */
  measured?: Measured
  /** 已经交给 SDK 的位移（画布像素） */
  delta: { dx: number; dy: number }
}

/** 草稿没收下这次移动：让 SDK 把元素放回原处 */
class MoveNotKept extends Error {
  constructor() {
    super('画面上的移动没有写进草稿')
    this.name = 'MoveNotKept'
  }
}

/**
 * 盖在预览画面上的一层：点画面上的视频、组件或字幕等于在时间线上点中它（先暂停），点空处清空选中；
 * 只选中，不打开组件浮层。选中的那一块在这一刻看得见时框住它画出来的部分。双击带标记的字或字幕，
 * 在画面上原位改字。按住特效块或字幕拖动，整块挪位置（字幕整片一起挪），靠近画面中线或四边时
 * 吸住并画参考线；松手记一步编辑，Esc 放弃。成片轨上的段只能选中，不能拖。
 */
export function CanvasLayer({
  iframe,
  canvas,
  draft,
  captions,
  playheadMs,
  selection,
  snap,
  onSelect,
  onPause,
  sentenceText,
  onCaptionText,
  onComponentText,
  onMove,
}: CanvasLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const cancelEditRef = useRef<(() => void) | null>(null)
  const [resized, setResized] = useState(0)
  const adapterRef = useRef<PreviewAdapter | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const stopEscapeRef = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)
  const [guides, setGuides] = useState<readonly Box[]>([])
  // 改字、拖动进行中提交时用最新的回调（读得到最新的草稿）
  const commitRef = useRef({ onCaptionText, onComponentText, onMove })
  useLayoutEffect(() => {
    commitRef.current = { onCaptionText, onComponentText, onMove }
  })

  /** 拖动结束（松手、放弃都走这里）：收起参考线，放开指针与 Esc */
  const endDrag = useCallback((drag: Drag) => {
    dragRef.current = null
    stopEscapeRef.current?.()
    stopEscapeRef.current = null
    const layer = layerRef.current
    if (layer?.hasPointerCapture(drag.pointerId)) layer.releasePointerCapture(drag.pointerId)
    setDragging(false)
    setGuides([])
  }, [])

  /** 放弃进行中的拖动：元素回到原处，选中框回到按下时量的位置 */
  const cancelDrag = useCallback(() => {
    const drag = dragRef.current
    if (drag === null) return
    if (drag.moved) adapterRef.current?.cancelPreview()
    const box = frameRef.current
    if (box !== null && drag.measured !== undefined) {
      placeFrame(box, drag.measured.area, drag.measured.box)
    }
    endDrag(drag)
  }, [endDrag])

  // 每个合成页一个 SDK 预览适配器；换页或拆掉时放弃进行中的改字与拖动（元素已经不在了）
  useEffect(() => {
    if (iframe === null) return
    adapterRef.current = createIframePreviewAdapter(iframe, (op) => {
      if (!commitRef.current.onMove(op)) throw new MoveNotKept()
    })
    return () => {
      cancelEditRef.current?.()
      cancelDrag()
      adapterRef.current = null
    }
  }, [iframe, cancelDrag])

  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    const observer = new ResizeObserver(() => setResized((count) => count + 1))
    observer.observe(layer)
    return () => observer.disconnect()
  }, [])

  /** 合成页上这一块（data-hf-id）此刻画出来的部分，量在这一层的坐标里；没画东西时 undefined */
  const measure = useCallback(
    (hfId: string): Measured | undefined => {
      const layer = layerRef.current
      const geometry = frameGeometry(iframe, canvas.width)
      if (layer === null || geometry === undefined) return undefined
      const { doc, win, rect, scale } = geometry
      const roots = [...doc.querySelectorAll('[data-hf-id]')].filter(
        (element) => element.getAttribute('data-hf-id') === hfId,
      )
      const bounds = paintedBounds(roots, win, canvas)
      if (bounds === null) return undefined
      const area = layer.getBoundingClientRect()
      const left = rect.left - area.left
      const top = rect.top - area.top
      return {
        area,
        frame: { left, top, width: rect.width, height: rect.height },
        box: {
          left: left + bounds.left * scale,
          top: top + bounds.top * scale,
          width: bounds.width * scale,
          height: bounds.height * scale,
        },
        scale,
      }
    },
    [iframe, canvas],
  )

  // 选中框：在合成页画出这一刻之后再量（跳转、换页后运行时要一两帧才画好）。拖动中不量，
  // 选中框跟着拖动挪
  const hfId = editing ? undefined : hfIdOnScreen(selection, draft, captions, playheadMs)
  useEffect(() => {
    const box = frameRef.current
    if (box === null) return
    box.hidden = true
    if (hfId === undefined) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (dragRef.current?.moved) return
        const measured = measure(hfId)
        if (measured !== undefined) placeFrame(box, measured.area, measured.box)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [hfId, measure, playheadMs, resized])

  const resolve = (id: string) => selectionOfHfId(id, draft, captions)

  /** 指针在合成页文档里的位置，与那一点上叠着的元素 */
  const pointAt = (clientX: number, clientY: number) => {
    const geometry = frameGeometry(iframe, canvas.width)
    if (geometry === undefined) return undefined
    const { doc, win, rect, scale } = geometry
    const point = { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale }
    return { win, point, scale, stack: stackAt(doc, win, point.x, point.y) }
  }

  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || iframe === null) return
    onPause()
    const at = pointAt(event.clientX, event.clientY)
    const hit = at === undefined ? null : hitAt(at.stack, at.win, at.point, resolve)
    onSelect(hit)
    // 特效块与字幕按住就准备拖；改字进行中不拖
    const target = cancelEditRef.current === null ? dragTargetOf(hit) : undefined
    const shown = hfIdOnScreen(hit, draft, captions, playheadMs)
    if (target === undefined || shown === undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      target,
      hfId: shown,
      originX: event.clientX,
      originY: event.clientY,
      from: positionOf(draft, target),
      moved: false,
      delta: { dx: 0, dy: 0 },
    }
    // Esc 只放弃这次拖动，不关编辑器：在窗口上先于弹窗（它在 document 上捕获）收下
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return
      key.preventDefault()
      key.stopPropagation()
      cancelDrag()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    stopEscapeRef.current = () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true })
  }

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current
    if (current === null || event.pointerId !== current.pointerId) return
    const dx = event.clientX - current.originX
    const dy = event.clientY - current.originY
    if (!current.moved) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return
      const measured = measure(current.hfId)
      if (measured === undefined) return
      current.moved = true
      current.measured = measured
      primeTransform(iframe, current.target)
      setDragging(true)
    }
    const { measured } = current
    if (measured === undefined) return
    const snapped = snapDrag({
      moving: measured.box,
      frame: measured.frame,
      dx,
      dy,
      enabled: snap,
    })
    const delta = canvasDelta({
      dx: snapped.dx,
      dy: snapped.dy,
      scale: measured.scale,
      from: current.from,
    })
    current.delta = delta
    adapterRef.current?.applyDraft(current.target, delta)
    const box = frameRef.current
    if (box !== null) {
      placeFrame(box, measured.area, {
        ...measured.box,
        left: measured.box.left + delta.dx * measured.scale,
        top: measured.box.top + delta.dy * measured.scale,
      })
    }
    setGuides((before) => (sameBoxes(before, snapped.guides) ? before : snapped.guides))
  }

  const release = (event: PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current
    if (current === null || event.pointerId !== current.pointerId) return
    // 没超过阈值是一次点击（双击改字照旧）；挪回原处的不记编辑
    if (!current.moved) {
      endDrag(current)
      return
    }
    if (current.delta.dx === 0 && current.delta.dy === 0) {
      cancelDrag()
      return
    }
    endDrag(current)
    try {
      adapterRef.current?.commitPreview()
    } catch (error) {
      // 草稿没收下（被拒的原因已经提示过）：SDK 已把元素放回原处，选中框也放回去
      if (!(error instanceof MoveNotKept)) throw error
      const box = frameRef.current
      if (box !== null && current.measured !== undefined) {
        placeFrame(box, current.measured.area, current.measured.box)
      }
    }
  }

  const edit = (event: MouseEvent<HTMLDivElement>) => {
    if (iframe === null || cancelEditRef.current !== null) return
    const at = pointAt(event.clientX, event.clientY)
    if (at === undefined) return
    const element = painterAt(at.stack, at.win, at.point)?.closest<HTMLElement>(EDITABLE_TEXT)
    if (element == null) return
    const found = ownerOf(element, resolve)
    if (found === undefined) return
    const { owner } = found
    let text: string | undefined
    let commit: (value: string) => boolean
    if (owner.kind === 'caption') {
      const caption = captions.find((item) => captionKey(item) === owner.key)
      if (caption === undefined) return
      text = sentenceText(caption)
      commit = (value) => commitRef.current.onCaptionText(caption, value)
    } else if (owner.kind === 'clip' || owner.kind === 'overlay') {
      const variable = element.getAttribute('data-var-text')
      if (variable === null) return
      const shown = element.textContent ?? ''
      commit = (value) =>
        commitRef.current.onComponentText({ id: owner.id, variable, text: value, shown })
    } else return
    onSelect(owner)
    const player = playerOf(iframe)
    const returnTo = document.activeElement
    // 让指针进到合成页里放光标；改完收回（播放器自己的开关，同 HyperFrames 的可交互合成）
    player?.setAttribute('interactive', '')
    setEditing(true)
    // 元素在屏幕上的缩放：合成页整体的缩放，再乘上组件自己的缩放盒子
    const own =
      element.offsetWidth > 0 ? element.getBoundingClientRect().width / element.offsetWidth : 1
    cancelEditRef.current = startTextEdit(element, {
      ...(text === undefined ? {} : { text }),
      pixel: 1 / (at.scale * (own > 0 ? own : 1)),
      onCommit: commit,
      onEnd: () => {
        cancelEditRef.current = null
        player?.removeAttribute('interactive')
        setEditing(false)
        // 回车、Esc 结束时焦点还留在合成页里，编辑器的快捷键收不到：还给改字之前的地方。
        // 点别处失焦结束的，焦点已经到了点的地方，不动它
        if (player === undefined || document.activeElement !== player) return
        const back =
          returnTo instanceof HTMLElement && returnTo !== player && returnTo.isConnected
            ? returnTo
            : layerRef.current?.closest<HTMLElement>('[role="dialog"]')
        back?.focus()
      },
    })
  }

  return (
    <div
      className={cn('wf-canvas', editing && 'is-editing', dragging && 'is-dragging')}
      onDoubleClick={edit}
      onLostPointerCapture={cancelDrag}
      onPointerCancel={cancelDrag}
      onPointerDown={press}
      onPointerMove={drag}
      onPointerUp={release}
      ref={layerRef}
    >
      <div className="wf-canvas-frame" hidden ref={frameRef} />
      {guides.map((guide) => (
        <i
          className="wf-canvas-guide"
          key={`${guide.left}:${guide.top}:${guide.width}`}
          style={{ left: guide.left, top: guide.top, width: guide.width, height: guide.height }}
        />
      ))}
    </div>
  )
}

const sameBoxes = (a: readonly Box[], b: readonly Box[]) =>
  a.length === b.length &&
  a.every(
    (box, index) =>
      box.left === b[index]?.left &&
      box.top === b[index]?.top &&
      box.width === b[index]?.width &&
      box.height === b[index]?.height,
  )

/**
 * 把选中框放在这块范围四周、留在画面以内：铺满画面的（视频段）框在画面边缘以内，
 * 其余在外面留 3 像素。
 */
function placeFrame(
  box: HTMLDivElement,
  area: DOMRect,
  bounds: { left: number; top: number; width: number; height: number },
) {
  const full =
    bounds.left <= 1 &&
    bounds.top <= 1 &&
    bounds.left + bounds.width >= area.width - 1 &&
    bounds.top + bounds.height >= area.height - 1
  const pad = full ? -2 : 3
  const left = Math.max(2, bounds.left - pad)
  const top = Math.max(2, bounds.top - pad)
  const right = Math.min(area.width - 2, bounds.left + bounds.width + pad)
  const bottom = Math.min(area.height - 2, bounds.top + bounds.height + pad)
  Object.assign(box.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.max(0, right - left)}px`,
    height: `${Math.max(0, bottom - top)}px`,
  })
  box.classList.toggle('is-full', full)
  box.hidden = false
}
