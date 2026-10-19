import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { cn } from '@/shared/lib/utils'
import { captionKey, hfIdOnScreen, selectionOfHfId } from './canvas-targets'
import { EDITABLE_TEXT, startTextEdit } from './canvas-text-edit'
import type { PlacedCaption } from './composition/captions'
import type { WholeFilmDraft } from './editing/draft'
import type { Selection } from './film-tracks'
import { hitAt, ownerOf, paintedBounds, painterAt, stackAt } from './painted-bounds'

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
  onSelect: (selection: Selection) => void
  /** 在画面上按下时先暂停 */
  onPause: () => void
  /** 改字时放进字幕里的整句：改过的字或识别结果 */
  sentenceText: (caption: PlacedCaption) => string
  /** 改完一句字幕；返回写没写进草稿 */
  onCaptionText: (caption: PlacedCaption, text: string) => boolean
  /** 改完组件的一项文字；返回写没写进草稿 */
  onComponentText: (change: ComponentText) => boolean
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

/** 播放器元素：iframe 在它的 shadow DOM 里 */
const playerOf = (iframe: HTMLIFrameElement) => {
  const root = iframe.getRootNode()
  return root instanceof ShadowRoot ? root.host : undefined
}

/**
 * 盖在预览画面上的一层：点画面上的视频、组件或字幕等于在时间线上点中它（先暂停），点空处清空选中；
 * 只选中，不打开组件浮层。选中的那一块在这一刻看得见时框住它画出来的部分。双击带标记的字或字幕，
 * 在画面上原位改字。
 */
export function CanvasLayer({
  iframe,
  canvas,
  draft,
  captions,
  playheadMs,
  selection,
  onSelect,
  onPause,
  sentenceText,
  onCaptionText,
  onComponentText,
}: CanvasLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const cancelEditRef = useRef<(() => void) | null>(null)
  const [resized, setResized] = useState(0)
  // 改字进行中提交时用最新的回调
  const commitRef = useRef({ onCaptionText, onComponentText })
  useLayoutEffect(() => {
    commitRef.current = { onCaptionText, onComponentText }
  })

  // 换页或拆掉时放弃进行中的改字（元素已经不在了）
  useEffect(() => () => cancelEditRef.current?.(), [iframe])

  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    const observer = new ResizeObserver(() => setResized((count) => count + 1))
    observer.observe(layer)
    return () => observer.disconnect()
  }, [])

  // 选中框：在合成页画出这一刻之后再量（跳转、换页后运行时要一两帧才画好）
  const hfId = editing ? undefined : hfIdOnScreen(selection, draft, captions, playheadMs)
  useEffect(() => {
    const box = frameRef.current
    const layer = layerRef.current
    if (box === null || layer === null) return
    box.hidden = true
    if (hfId === undefined) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const geometry = frameGeometry(iframe, canvas.width)
        if (geometry === undefined) return
        const { doc, win, rect, scale } = geometry
        const roots = [...doc.querySelectorAll('[data-hf-id]')].filter(
          (element) => element.getAttribute('data-hf-id') === hfId,
        )
        const bounds = paintedBounds(roots, win, canvas)
        if (bounds === null) return
        const area = layer.getBoundingClientRect()
        placeFrame(box, area, {
          left: rect.left - area.left + bounds.left * scale,
          top: rect.top - area.top + bounds.top * scale,
          width: bounds.width * scale,
          height: bounds.height * scale,
        })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [hfId, iframe, canvas, playheadMs, resized])

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
    onSelect(at === undefined ? null : hitAt(at.stack, at.win, at.point, resolve))
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
      className={cn('wf-canvas', editing && 'is-editing')}
      onDoubleClick={edit}
      onPointerDown={press}
      ref={layerRef}
    >
      <div className="wf-canvas-frame" hidden ref={frameRef} />
    </div>
  )
}

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
