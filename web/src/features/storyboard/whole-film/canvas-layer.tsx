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

export type ComponentText = { id: string; variable: string; text: string; shown: string }

type CanvasLayerProps = {
  iframe: HTMLIFrameElement | null
  canvas: { width: number; height: number }
  draft: WholeFilmDraft
  captions: readonly PlacedCaption[]
  playheadMs: number
  playing: boolean
  selection: Selection
  snap: boolean
  componentTitle: (component: string) => string
  onSelect: (selection: Selection) => void
  onPause: () => void
  sentenceText: (caption: PlacedCaption) => string
  onCaptionText: (caption: PlacedCaption, text: string) => boolean
  onComponentText: (change: ComponentText) => boolean
  onMove: (op: EditOp) => boolean
  onTransform: (target: string, args: TransformArgs) => boolean
}

type ContentWindow = Window & typeof globalThis

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

function primeTransform(iframe: HTMLIFrameElement | null, hfId: string) {
  const element = iframe?.contentDocument?.querySelector(`[data-hf-id="${CSS.escape(hfId)}"]`)
  if (element == null) return
  ;(iframe?.contentWindow as GsapWindow | null | undefined)?.gsap?.getProperty?.(element, 'x')
}

const playerOf = (iframe: HTMLIFrameElement) => {
  const root = iframe.getRootNode()
  return root instanceof ShadowRoot ? root.host : undefined
}

const NEUTRAL = ['transform', 'translate', 'rotate', 'scale'] as const

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

function previewPlacement(place: HTMLElement, saved: string, placement: Placement) {
  place.style.cssText = saved
  place.style.setProperty('transform', 'none')
  place.style.setProperty('translate', `${placement.x}px ${placement.y}px`)
  place.style.setProperty('rotate', `${placement.rotation}deg`)
  place.style.setProperty('scale', String(placement.scale))
  place.style.setProperty('transform-origin', `${placement.pivot.x}px ${placement.pivot.y}px`)
}

const UNPLACED: Placement = { x: 0, y: 0, scale: 1, rotation: 0, pivot: { x: 0, y: 0 } }

const PAD = 3
const READOUT_OFFSET = 14
const READOUT_INSET = 4

type Measured = {
  area: DOMRect
  picture: Box
  scale: number
  local: Box
  place: HTMLElement | null
}

const onScreen = (measured: Measured, placement: Placement): Placed =>
  placedOnScreen(placedBox(measured.local, placement), measured.picture, measured.scale)

type MoveGesture = {
  kind: 'move'
  pointerId: number
  target: string
  hfId: string
  originX: number
  originY: number
  from: Placement
  moved: boolean
  measured?: Measured
  startFrame?: Placed
  delta: { dx: number; dy: number }
}

type TransformGesture = {
  kind: 'scale' | 'rotate'
  pointerId: number
  target: string
  measured: Measured
  saved: string
  from: Placement
  pivot: Point
  pivotScreen: Point
  start: Point
  startFrame: Placed
  scale: number
  rotation: number
}

type Gesture = MoveGesture | TransformGesture

type Outline = { hfId: string; selection: NonNullable<Selection>; label: string; at: Placed }
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

class MoveNotKept extends Error {
  constructor() {
    super('画面上的移动没有写进草稿')
    this.name = 'MoveNotKept'
  }
}

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
  const commitRef = useRef({ onCaptionText, onComponentText, onMove, onTransform, componentTitle })
  useLayoutEffect(() => {
    commitRef.current = { onCaptionText, onComponentText, onMove, onTransform, componentTitle }
  })

  const hideFrame = useCallback(() => {
    if (frameRef.current !== null) frameRef.current.hidden = true
    shownRef.current = null
  }, [])

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

  const endGesture = useCallback((gesture: Gesture) => {
    gestureRef.current = null
    stopEscapeRef.current?.()
    stopEscapeRef.current = null
    const layer = layerRef.current
    if (layer?.hasPointerCapture(gesture.pointerId)) layer.releasePointerCapture(gesture.pointerId)
    if (readoutRef.current !== null) readoutRef.current.hidden = true
    setMode(null)
    setGuides([])
  }, [])

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

  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current
    if (gesture === null) return
    if (gesture.kind === 'move' && gesture.moved) adapterRef.current?.cancelPreview()
    restore(gesture)
    endGesture(gesture)
  }, [endGesture, restore])

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

  const hfId = editing ? undefined : hfIdOnScreen(selection, draft, captions, playheadMs)
  const target = dragTargetOf(selection)
  useEffect(() => {
    if (hfId === undefined) {
      hideFrame()
      return
    }
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

  useEffect(() => {
    if (playing || editing || iframe === null) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
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

  const pointAt = (clientX: number, clientY: number) => {
    const geometry = frameGeometry(iframe, canvas.width)
    if (geometry === undefined) return undefined
    const { doc, win, rect, scale } = geometry
    const point = { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale }
    const inside =
      point.x >= 0 && point.y >= 0 && point.x <= canvas.width && point.y <= canvas.height
    return { win, point, scale, inside, stack: inside ? stackAt(doc, win, point.x, point.y) : [] }
  }

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
      const id = owner.kind === 'clip' ? owner.ids[0] : owner.id
      commit = (value) => commitRef.current.onComponentText({ id, variable, text: value, shown })
    } else return
    onSelect(owner)
    const player = playerOf(iframe)
    const returnTo = document.activeElement
    player?.setAttribute('interactive', '')
    setEditing(true)
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
        <div className="wf-canvas-offframes" style={{ clipPath: outlines?.clip }}>
          {shownOutlines.map((item) => (
            <button
              aria-label={`选中画面外的${item.label}`}
              className="wf-canvas-offframe ui-focus"
              data-outline={item.hfId}
              key={item.hfId}
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
