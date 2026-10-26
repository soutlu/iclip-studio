import type { EditOp, PreviewAdapter } from '@hyperframes/sdk'
import { createIframePreviewAdapter } from '@hyperframes/sdk/adapters/iframe'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { DRAG_THRESHOLD } from '../editing/timeline-drag'
import { canvasDelta, dragTargetOf, snapDrag } from './canvas-drag'
import { captionKey, hfIdOnScreen, selectionOfHfId } from './canvas-targets'
import { EDITABLE_TEXT, startTextEdit } from './canvas-text-edit'
import {
  CORNERS,
  cornerCursor,
  formatRotation,
  formatScale,
  insidePlaced,
  outsideCanvas,
  outsidePictureClip,
  pivotOf,
  placedBox,
  placedOnScreen,
  placementOf,
  rotateGesture,
  scaleGesture,
  type Corner,
  type Placed,
  type Placement,
  type Point,
} from './canvas-transform'
import type { PlacedCaption } from './composition/captions'
import type { TransformArgs, WholeFilmDraft } from './editing/draft'
import type { Selection } from './selection'
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
  /** 正在播放：播放中不画伸出画面的轮廓 */
  playing: boolean
  selection: Selection
  /** 拖动时吸附画面的中线与四边、缩放时吸到 100%（编辑器的「吸附」开关） */
  snap: boolean
  /** 组件的名字（组件目录里的标题），伸出画面的轮廓按它称呼特效块 */
  componentTitle: (component: string) => string
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
  /** 缩放、旋转完松手：哪个元素（特效块的草稿 id 或全部字幕）、缩放旋转成什么；返回写没写进草稿 */
  onTransform: (target: string, args: TransformArgs) => boolean
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

const NEUTRAL = ['transform', 'translate', 'rotate', 'scale'] as const

/**
 * 摘掉外层（.place）上的位置、缩放与旋转量一次，再原样放回。都在同一段同步代码里，画面不重画、
 * 不闪。四项都摘：GSAP 解析过之后把 rotate、scale 折进了 transform，translate 另写着。
 */
function untransformed<T>(place: HTMLElement | null, read: () => T): T {
  if (place === null) return read()
  const saved = place.style.cssText
  for (const property of NEUTRAL) place.style.setProperty(property, 'none')
  try {
    return read()
  } finally {
    place.style.cssText = saved
  }
}

/**
 * 缩放、旋转进行中把这一刻的摆放直接写在外层上，松手写进草稿后换页才按草稿重画。transform 清掉、
 * 四项都写明：GSAP 已把 rotate、scale 折进 transform，只改单项会叠两遍。
 */
function previewPlacement(place: HTMLElement, saved: string, placement: Placement) {
  place.style.cssText = saved
  place.style.setProperty('transform', 'none')
  place.style.setProperty('translate', `${placement.x}px ${placement.y}px`)
  place.style.setProperty('rotate', `${placement.rotation}deg`)
  place.style.setProperty('scale', String(placement.scale))
  place.style.setProperty('transform-origin', `${placement.pivot.x}px ${placement.pivot.y}px`)
}

/** 画面轨上的段没有外层，按原处、原大、不转算 */
const UNPLACED: Placement = { x: 0, y: 0, scale: 1, rotation: 0, pivot: { x: 0, y: 0 } }

/** 选中框在这一块四周留的空 */
const PAD = 3
/** 读数离指针多远、离卡片边至少多远 */
const READOUT_OFFSET = 14
const READOUT_INSET = 4

/** 画面上量出来的一块：屏幕上的都在这一层自己的坐标里（相对预览卡片的左上角，屏幕像素） */
type Measured = {
  /** 这一层（预览卡片）在屏幕上的范围 */
  area: DOMRect
  /** 画面（iframe）在这一层里的范围 */
  picture: Box
  /** 画布 1 像素在屏幕上多宽（iframe 宽 / 画布宽） */
  scale: number
  /** 这一块不挪开、不缩放、不旋转时画出来的部分（画布像素） */
  local: Box
  /** 写着位置、缩放、旋转的外层；画面轨上的段没有 */
  place: HTMLElement | null
}

/** 按草稿里的摆放，这一块在这一层里的样子 */
const onScreen = (measured: Measured, placement: Placement): Placed =>
  placedOnScreen(placedBox(measured.local, placement), measured.picture, measured.scale)

/** 进行中的拖动；没超过阈值时 moved 为 false，松手只算一次点击 */
type MoveGesture = {
  kind: 'move'
  pointerId: number
  /** 拖哪个元素（data-hf-id）：特效块的草稿 id，或全部字幕 */
  target: string
  /** 选中框框着的那一块（字幕是选中的那一句） */
  hfId: string
  originX: number
  originY: number
  /** 按下时草稿里记着的摆放 */
  from: Placement
  moved: boolean
  /** 超过阈值时量一次与那时的选中框；拖动中不再量，选中框按同样的位移挪 */
  measured?: Measured
  startFrame?: Placed
  /** 已经交给 SDK 的位移（画布像素） */
  delta: { dx: number; dy: number }
}

/** 进行中的缩放或旋转：按下把手就开始 */
type TransformGesture = {
  kind: 'scale' | 'rotate'
  pointerId: number
  target: string
  measured: Measured
  /** 外层按下时的行内样式，放弃时原样放回 */
  saved: string
  from: Placement
  /** 绕的转轴（画布像素，挪开之前）与它在这一层里的位置 */
  pivot: Point
  pivotScreen: Point
  /** 按下的位置（这一层的坐标） */
  start: Point
  startFrame: Placed
  /** 这一刻的倍数与角度 */
  scale: number
  rotation: number
}

type Gesture = MoveGesture | TransformGesture

/** 伸出画面的一块没选中的：框外那部分画淡虚线，点一下选中它 */
type Outline = { hfId: string; selection: NonNullable<Selection>; label: string; at: Placed }
/** 量出来的轮廓与量的是哪一刻：合成页、草稿、播放头、选中都还是那时的才画 */
type Outlines = {
  clip: string
  items: readonly Outline[]
  at: {
    iframe: HTMLIFrameElement
    draft: WholeFilmDraft
    playheadMs: number
    selection: Selection
    resized: number
  }
}

const sameOutlines = (a: Outlines | null, b: Outlines) =>
  a !== null &&
  a.at.iframe === b.at.iframe &&
  a.at.draft === b.at.draft &&
  a.at.playheadMs === b.at.playheadMs &&
  a.at.selection === b.at.selection &&
  a.at.resized === b.at.resized &&
  a.clip === b.clip &&
  a.items.length === b.items.length &&
  a.items.every((item, index) => {
    const other = b.items[index]
    return (
      other !== undefined &&
      item.hfId === other.hfId &&
      item.label === other.label &&
      samePlaced(item.at, other.at)
    )
  })

const samePlaced = (a: Placed, b: Placed) =>
  a.cx === b.cx &&
  a.cy === b.cy &&
  a.width === b.width &&
  a.height === b.height &&
  a.angle === b.angle

/** 一块转过的范围四周各留 pad：转之前的框，绕自己的中心转 */
const placedRect = (at: Placed, pad: number) => ({
  left: at.cx - at.width / 2 - pad,
  top: at.cy - at.height / 2 - pad,
  width: at.width + pad * 2,
  height: at.height + pad * 2,
})

const placedStyle = (at: Placed, pad: number): CSSProperties => ({
  ...placedRect(at, pad),
  rotate: `${at.angle}deg`,
})

/** 被拒的原因已经提示过：让 SDK 把元素放回原处 */
class MoveNotKept extends Error {
  constructor() {
    super('画面上的移动没有写进草稿')
    this.name = 'MoveNotKept'
  }
}

/**
 * 铺满预览卡片的一层：点画面上的视频、组件或字幕等于在时间线上点中它（先暂停），点空处清空选中；
 * 只选中，不打开组件浮层。选中的那一块在这一刻看得见时框住它画出来的部分，伸出画面也照样框。
 * 双击带标记的字或字幕，在画面上原位改字。按住特效块或字幕拖动，整块挪位置（全部字幕一起挪），
 * 能拖出画面；没转过的靠近画面中线或四边时吸住并画参考线。选中框四角拖动等比缩放，下方圆把手拖动
 * 旋转（按住 Shift 每 15° 一档），都绕这一块画出来那块的中心。每个手势松手记一步编辑，Esc 放弃。
 * 画面轨上的段只能选中。停下时，没选中的特效块、字幕伸出画面的部分画淡虚线，点一下选中。
 */
export function CanvasLayer({
  iframe,
  canvas,
  draft,
  captions,
  playheadMs,
  playing,
  selection,
  snap,
  componentTitle,
  onSelect,
  onPause,
  sentenceText,
  onCaptionText,
  onComponentText,
  onMove,
  onTransform,
}: CanvasLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const readoutRef = useRef<HTMLSpanElement>(null)
  /** 选中框此刻框着哪一块、画在哪：画面外按住选中的那一块时按它判断 */
  const shownRef = useRef<{ hfId: string; at: Placed } | null>(null)
  const [editing, setEditing] = useState(false)
  const cancelEditRef = useRef<(() => void) | null>(null)
  const [resized, setResized] = useState(0)
  const adapterRef = useRef<PreviewAdapter | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const stopEscapeRef = useRef<(() => void) | null>(null)
  const [mode, setMode] = useState<Gesture['kind'] | null>(null)
  const [guides, setGuides] = useState<readonly Box[]>([])
  const [outlines, setOutlines] = useState<Outlines | null>(null)
  // 改字、拖动进行中提交时用最新的回调（读得到最新的草稿）
  const commitRef = useRef({ onCaptionText, onComponentText, onMove, onTransform, componentTitle })
  useLayoutEffect(() => {
    commitRef.current = { onCaptionText, onComponentText, onMove, onTransform, componentTitle }
  })

  const hideFrame = useCallback(() => {
    if (frameRef.current !== null) frameRef.current.hidden = true
    shownRef.current = null
  }, [])

  /**
   * 把选中框放在这一块四周、跟着它转：铺满画面的（视频段）框在画面边缘以内，其余在外面留 3 像素，
   * 伸出画面也不裁。角把手的指针随角度换方向。
   */
  const showFrame = useCallback((hfId: string, at: Placed, picture: Box) => {
    const box = frameRef.current
    if (box === null) return
    const full =
      at.angle === 0 &&
      at.cx - at.width / 2 <= picture.left + 1 &&
      at.cy - at.height / 2 <= picture.top + 1 &&
      at.cx + at.width / 2 >= picture.left + picture.width - 1 &&
      at.cy + at.height / 2 >= picture.top + picture.height - 1
    const rect = placedRect(at, full ? -2 : PAD)
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      rotate: `${at.angle}deg`,
    })
    box.classList.toggle('is-full', full)
    for (const handle of box.querySelectorAll<HTMLElement>('[data-corner]')) {
      handle.style.cursor = cornerCursor(handle.dataset['corner'] as Corner, at.angle)
    }
    box.hidden = false
    shownRef.current = { hfId, at }
  }, [])

  /** 缩放、旋转时指针旁边显示倍数或角度，不出预览卡片 */
  const showReadout = (text: string, point: Point, area: DOMRect) => {
    const chip = readoutRef.current
    if (chip === null) return
    chip.textContent = text
    chip.hidden = false
    const left = Math.min(point.x + READOUT_OFFSET, area.width - chip.offsetWidth - READOUT_INSET)
    const top = Math.min(point.y + READOUT_OFFSET, area.height - chip.offsetHeight - READOUT_INSET)
    chip.style.left = `${Math.max(READOUT_INSET, left)}px`
    chip.style.top = `${Math.max(READOUT_INSET, top)}px`
  }

  /** 手势结束（松手、放弃都走这里）：收起参考线与读数，放开指针与 Esc */
  const endGesture = useCallback((gesture: Gesture) => {
    // 先清掉再放指针：放开指针会同步触发 lostpointercapture，那时已经没有进行中的手势
    gestureRef.current = null
    stopEscapeRef.current?.()
    stopEscapeRef.current = null
    const layer = layerRef.current
    if (layer?.hasPointerCapture(gesture.pointerId)) layer.releasePointerCapture(gesture.pointerId)
    if (readoutRef.current !== null) readoutRef.current.hidden = true
    setMode(null)
    setGuides([])
  }, [])

  /** 元素与选中框回到手势开始时的样子 */
  const restore = useCallback(
    (gesture: Gesture) => {
      if (gesture.kind === 'move') {
        if (gesture.measured !== undefined && gesture.startFrame !== undefined) {
          showFrame(gesture.hfId, gesture.startFrame, gesture.measured.picture)
        }
        return
      }
      if (gesture.measured.place !== null) gesture.measured.place.style.cssText = gesture.saved
      const hfId = shownRef.current?.hfId
      if (hfId !== undefined) showFrame(hfId, gesture.startFrame, gesture.measured.picture)
    },
    [showFrame],
  )

  /** 放弃进行中的手势：元素回到原处，选中框回到开始时的位置 */
  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current
    if (gesture === null) return
    if (gesture.kind === 'move' && gesture.moved) adapterRef.current?.cancelPreview()
    restore(gesture)
    endGesture(gesture)
  }, [endGesture, restore])

  // 每个合成页一个 SDK 预览适配器；换页或拆掉时放弃进行中的改字与手势（元素已经不在了）
  useEffect(() => {
    if (iframe === null) return
    adapterRef.current = createIframePreviewAdapter(iframe, (op) => {
      if (!commitRef.current.onMove(op)) throw new MoveNotKept()
    })
    return () => {
      cancelEditRef.current?.()
      cancelGesture()
      adapterRef.current = null
    }
  }, [iframe, cancelGesture])

  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    const observer = new ResizeObserver(() => setResized((count) => count + 1))
    observer.observe(layer)
    return () => observer.disconnect()
  }, [])

  /**
   * 合成页上这一块（data-hf-id）不挪开、不缩放、不旋转时画出来的部分；`target` 是写着摆放的外层
   * （特效块自己或全部字幕），量的时候临时摘掉它的变换。没画东西时 undefined。
   */
  const measure = useCallback(
    (hfId: string, target: string | undefined): Measured | undefined => {
      const layer = layerRef.current
      const geometry = frameGeometry(iframe, canvas.width)
      if (layer === null || geometry === undefined) return undefined
      const { doc, win, rect, scale } = geometry
      const roots = [...doc.querySelectorAll('[data-hf-id]')].filter(
        (element) => element.getAttribute('data-hf-id') === hfId,
      )
      const place =
        target === undefined
          ? null
          : doc.querySelector<HTMLElement>(`[data-hf-id="${CSS.escape(target)}"]`)
      const local = untransformed(place, () => paintedBounds(roots, win, canvas))
      if (local === null) return undefined
      const area = layer.getBoundingClientRect()
      return {
        area,
        picture: {
          left: rect.left - area.left,
          top: rect.top - area.top,
          width: rect.width,
          height: rect.height,
        },
        scale,
        local,
        place,
      }
    },
    [iframe, canvas],
  )

  // 选中框：在合成页画出这一刻之后再量（跳转、换页后运行时要一两帧才画好）。手势进行中不量，
  // 选中框跟着手势走
  const hfId = editing ? undefined : hfIdOnScreen(selection, draft, captions, playheadMs)
  const target = dragTargetOf(selection)
  useEffect(() => {
    if (hfId === undefined) {
      hideFrame()
      return
    }
    // 换了一块先藏起来，同一块（编辑后、跳转后）留在原处等新的位置，不闪
    if (shownRef.current?.hfId !== hfId) hideFrame()
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const gesture = gestureRef.current
        if (gesture !== null && (gesture.kind !== 'move' || gesture.moved)) return
        const measured = measure(hfId, target)
        if (measured === undefined) {
          hideFrame()
          return
        }
        const placement = target === undefined ? UNPLACED : placementOf(draft, target)
        showFrame(hfId, onScreen(measured, placement), measured.picture)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [hfId, target, draft, measure, playheadMs, resized, hideFrame, showFrame])

  // 伸出画面的轮廓：只在停下时量，播放中不画，也不加每帧的开销；选中的那一块画选中框，不画轮廓
  useEffect(() => {
    if (playing || editing || iframe === null) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        // 拖起来、缩放旋转中的不量（松手改了草稿会再量）；按下还没拖的只是一次点击，照量
        const gesture = gestureRef.current
        if (gesture !== null && (gesture.kind !== 'move' || gesture.moved)) return
        const selected = hfIdOnScreen(selection, draft, captions, playheadMs)
        const within = (start: number, end: number) => start <= playheadMs && playheadMs < end
        const candidates: Omit<Outline, 'at'>[] = draft.overlays
          .filter((overlay) => within(overlay.start, overlay.start + overlay.duration))
          .map((overlay) => ({
            hfId: overlay.id,
            selection: { kind: 'overlay', id: overlay.id },
            label: `特效 · ${commitRef.current.componentTitle(overlay.component)}`,
          }))
        const index = captions.findIndex((caption) => within(caption.start, caption.end))
        const caption = captions[index]
        if (caption !== undefined) {
          candidates.push({
            hfId: `caption:${index}`,
            selection: { kind: 'caption', key: captionKey(caption) },
            label: '字幕',
          })
        }
        let clip = ''
        const items = candidates.flatMap((candidate): Outline[] => {
          if (candidate.hfId === selected) return []
          const owner = dragTargetOf(candidate.selection)
          if (owner === undefined) return []
          const measured = measure(candidate.hfId, owner)
          if (measured === undefined) return []
          const placed = placedBox(measured.local, placementOf(draft, owner))
          if (!outsideCanvas(placed, canvas)) return []
          clip = outsidePictureClip(measured.area, measured.picture)
          const at = placedOnScreen(placed, measured.picture, measured.scale)
          return [{ ...candidate, at }]
        })
        const next = { clip, items, at: { iframe, draft, playheadMs, selection, resized } }
        setOutlines((before) => (sameOutlines(before, next) ? before : next))
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [iframe, draft, captions, playheadMs, selection, playing, editing, resized, measure, canvas])
  // 播放中、改字时不画；量过之后合成页、草稿、播放头、选中或大小变了，等重新量好再画
  const shownOutlines =
    !playing &&
    !editing &&
    outlines !== null &&
    outlines.at.iframe === iframe &&
    outlines.at.draft === draft &&
    outlines.at.playheadMs === playheadMs &&
    outlines.at.selection === selection &&
    outlines.at.resized === resized
      ? outlines.items
      : []

  const resolve = (id: string) => selectionOfHfId(id, draft, captions)

  /** 指针在合成页文档里的位置、在不在画面里，与画面里那一点上叠着的元素 */
  const pointAt = (clientX: number, clientY: number) => {
    const geometry = frameGeometry(iframe, canvas.width)
    if (geometry === undefined) return undefined
    const { doc, win, rect, scale } = geometry
    const point = { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale }
    const inside =
      point.x >= 0 && point.y >= 0 && point.x <= canvas.width && point.y <= canvas.height
    return { win, point, scale, inside, stack: inside ? stackAt(doc, win, point.x, point.y) : [] }
  }

  /**
   * 按下的地方是哪一块：画面里按画面上画出来的算；画面外只有选中的那一块伸出去的部分（选中框以内）
   * 接得住，好把它拖回来，别处清空选中
   */
  const hitOf = (clientX: number, clientY: number): Selection => {
    const at = pointAt(clientX, clientY)
    if (at === undefined) return null
    if (at.inside) return hitAt(at.stack, at.win, at.point, resolve)
    const shown = shownRef.current
    const layer = layerRef.current
    if (shown === null || layer === null || dragTargetOf(selection) === undefined) return null
    const area = layer.getBoundingClientRect()
    const point = { x: clientX - area.left, y: clientY - area.top }
    return insidePlaced(point, shown.at, PAD) ? selection : null
  }

  /** Esc 只放弃这次手势，不关编辑器：在窗口上先于弹窗（它在 document 上捕获）收下 */
  const listenEscape = () => {
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return
      key.preventDefault()
      key.stopPropagation()
      cancelGesture()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    stopEscapeRef.current = () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true })
  }

  /** 按下选中框上的角把手或旋转把手：量一次这一块，记下转轴 */
  const startTransform = (event: PointerEvent<HTMLDivElement>, kind: 'scale' | 'rotate') => {
    if (target === undefined || hfId === undefined) return
    const measured = measure(hfId, target)
    if (measured === undefined) return
    const from = placementOf(draft, target)
    const pivot = pivotOf(measured.local, from)
    const { area, picture, scale } = measured
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      kind,
      pointerId: event.pointerId,
      target,
      measured,
      saved: measured.place?.style.cssText ?? '',
      from,
      pivot,
      pivotScreen: {
        x: picture.left + (pivot.x + from.x) * scale,
        y: picture.top + (pivot.y + from.y) * scale,
      },
      start: { x: event.clientX - area.left, y: event.clientY - area.top },
      startFrame: onScreen(measured, from),
      scale: from.scale,
      rotation: from.rotation,
    }
    listenEscape()
    setMode(kind)
  }

  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || iframe === null) return
    onPause()
    const element = event.target instanceof Element ? event.target : null
    const handle = element?.closest<HTMLElement>('[data-handle]')?.dataset['handle']
    if (handle === 'scale' || handle === 'rotate') {
      startTransform(event, handle)
      return
    }
    const outline = element?.closest<HTMLElement>('[data-outline]')?.dataset['outline']
    const hit =
      outline === undefined
        ? hitOf(event.clientX, event.clientY)
        : (shownOutlines.find((item) => item.hfId === outline)?.selection ?? null)
    onSelect(hit)
    // 特效块与字幕按住就准备拖；改字进行中不拖
    const dragged = cancelEditRef.current === null ? dragTargetOf(hit) : undefined
    const shown = hfIdOnScreen(hit, draft, captions, playheadMs)
    if (dragged === undefined || shown === undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      kind: 'move',
      pointerId: event.pointerId,
      target: dragged,
      hfId: shown,
      originX: event.clientX,
      originY: event.clientY,
      from: placementOf(draft, dragged),
      moved: false,
      delta: { dx: 0, dy: 0 },
    }
    listenEscape()
  }

  const moveBy = (current: MoveGesture, event: PointerEvent<HTMLDivElement>) => {
    const dx = event.clientX - current.originX
    const dy = event.clientY - current.originY
    if (!current.moved) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return
      const measured = measure(current.hfId, current.target)
      if (measured === undefined) return
      current.moved = true
      current.measured = measured
      current.startFrame = onScreen(measured, current.from)
      primeTransform(iframe, current.target)
      setMode('move')
    }
    const { measured, startFrame } = current
    if (measured === undefined || startFrame === undefined) return
    const snapped = snapDrag({
      moving: {
        left: startFrame.cx - startFrame.width / 2,
        top: startFrame.cy - startFrame.height / 2,
        width: startFrame.width,
        height: startFrame.height,
      },
      frame: measured.picture,
      dx,
      dy,
      enabled: snap,
      rotated: current.from.rotation !== 0,
    })
    const delta = canvasDelta({
      dx: snapped.dx,
      dy: snapped.dy,
      scale: measured.scale,
      from: current.from,
    })
    current.delta = delta
    adapterRef.current?.applyDraft(current.target, delta)
    showFrame(
      current.hfId,
      {
        ...startFrame,
        cx: startFrame.cx + delta.dx * measured.scale,
        cy: startFrame.cy + delta.dy * measured.scale,
      },
      measured.picture,
    )
    setGuides((before) => (sameBoxes(before, snapped.guides) ? before : snapped.guides))
  }

  const transformBy = (current: TransformGesture, event: PointerEvent<HTMLDivElement>) => {
    const { measured, from, pivotScreen, start } = current
    const point = { x: event.clientX - measured.area.left, y: event.clientY - measured.area.top }
    if (current.kind === 'scale') {
      current.scale = scaleGesture({
        pivot: pivotScreen,
        start,
        current: point,
        from: from.scale,
        snap,
      })
    } else {
      current.rotation = rotateGesture({
        pivot: pivotScreen,
        start,
        current: point,
        from: from.rotation,
        shift: event.shiftKey,
      })
    }
    const placement = {
      ...from,
      scale: current.scale,
      rotation: current.rotation,
      pivot: current.pivot,
    }
    if (measured.place !== null) previewPlacement(measured.place, current.saved, placement)
    const hfIdShown = shownRef.current?.hfId
    if (hfIdShown !== undefined)
      showFrame(hfIdShown, onScreen(measured, placement), measured.picture)
    showReadout(
      current.kind === 'scale' ? formatScale(current.scale) : formatRotation(current.rotation),
      point,
      measured.area,
    )
  }

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current
    if (current === null || event.pointerId !== current.pointerId) return
    if (current.kind === 'move') moveBy(current, event)
    else transformBy(current, event)
  }

  const releaseTransform = (current: TransformGesture) => {
    endGesture(current)
    const { from, scale, rotation, pivot } = current
    // 转回原样的不记编辑；草稿没收下的（原因已经提示过）放回原处。收下的留着画面上的样子，换页后
    // 按草稿重画
    if (
      (scale === from.scale && rotation === from.rotation) ||
      !commitRef.current.onTransform(current.target, { scale, rotation, pivot })
    ) {
      restore(current)
    }
  }

  const release = (event: PointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current
    if (current === null || event.pointerId !== current.pointerId) return
    if (current.kind !== 'move') {
      releaseTransform(current)
      return
    }
    // 没超过阈值是一次点击（双击改字照旧）；挪回原处的不记编辑
    if (!current.moved) {
      endGesture(current)
      return
    }
    if (current.delta.dx === 0 && current.delta.dy === 0) {
      cancelGesture()
      return
    }
    endGesture(current)
    try {
      adapterRef.current?.commitPreview()
    } catch (error) {
      // 草稿没收下（被拒的原因已经提示过）：SDK 已把元素放回原处，选中框也放回去
      if (!(error instanceof MoveNotKept)) throw error
      restore(current)
    }
  }

  const edit = (event: MouseEvent<HTMLDivElement>) => {
    if (iframe === null || cancelEditRef.current !== null) return
    const at = pointAt(event.clientX, event.clientY)
    if (at === undefined || !at.inside) return
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
      // 画面上点中的总是一段
      const id = owner.kind === 'clip' ? owner.ids[0] : owner.id
      commit = (value) => commitRef.current.onComponentText({ id, variable, text: value, shown })
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
      className={cn(
        'wf-canvas',
        editing && 'is-editing',
        mode === 'move' && 'is-dragging',
        mode === 'rotate' && 'is-rotating',
      )}
      onDoubleClick={edit}
      onLostPointerCapture={cancelGesture}
      onPointerCancel={cancelGesture}
      onPointerDown={press}
      onPointerMove={drag}
      onPointerUp={release}
      ref={layerRef}
    >
      {shownOutlines.length === 0 ? null : (
        // 框内那块挖掉，只露出画面外的轮廓
        <div className="wf-canvas-offframes" style={{ clipPath: outlines?.clip }}>
          {shownOutlines.map((item) => (
            <button
              aria-label={`选中画面外的${item.label}`}
              className="wf-canvas-offframe ui-focus"
              data-outline={item.hfId}
              key={item.hfId}
              // 指针按下时这一层已经选中并准备拖；这里接键盘
              onClick={() => onSelect(item.selection)}
              style={placedStyle(item.at, 0)}
              type="button"
            />
          ))}
        </div>
      )}
      <div className="wf-canvas-frame" hidden ref={frameRef}>
        {target === undefined ? null : (
          <>
            {CORNERS.map((corner) => (
              <i
                className="wf-canvas-handle"
                data-corner={corner}
                data-handle="scale"
                key={corner}
              />
            ))}
            <span className="wf-canvas-rotate" data-handle="rotate" title="旋转">
              <Icon decorative name="rotate" size="xs" />
            </span>
          </>
        )}
      </div>
      {guides.map((guide) => (
        <i
          className="wf-canvas-guide"
          key={`${guide.left}:${guide.top}:${guide.width}`}
          style={{ left: guide.left, top: guide.top, width: guide.width, height: guide.height }}
        />
      ))}
      <span className="wf-canvas-readout" hidden ref={readoutRef} />
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
