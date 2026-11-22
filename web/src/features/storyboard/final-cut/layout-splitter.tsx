import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { cn } from '@/shared/lib/utils'
import type { SplitterHandlers } from './use-editor-layout'

// 方向键每按一下挪这么多像素，和工作台的分隔条一样
const KEY_STEP = 16

type LayoutSplitterProps = SplitterHandlers & {
  /** `vertical` 是两栏之间的竖条（左右拖），`horizontal` 是上下两块之间的横条（上下拖）。 */
  orientation: 'vertical' | 'horizontal'
  label: string
  /** 这条分隔条调的那一块：说明里写它实际排出来多宽（竖条）或多高（横条）。 */
  panelRef: RefObject<HTMLElement | null>
  /** 那一块的尺寸是拖定的；没定过（按内容高）时说明里不写当前尺寸。 */
  sized: boolean
  min: number
  /** 最大能拉到多大；要看编辑器有多大时不给。 */
  max?: number
  className: string
}

/**
 * final-cut 编辑器里调右栏宽度、时间线高度的分隔条：占着两块之间的那道缝，悬停、拖动时中间亮出一道短把手。
 * 按住拖，方向键一下挪 16px，拖到一半按 Esc 或切走窗口退回按下前，双击恢复默认。
 * 和工作台的 `ResizeHandle` 同一套手势和写法，但它浮在两栏的分界线上、只能左右拖，这里要占格子、两个方向都要。
 */
export function LayoutSplitter({
  orientation,
  label,
  panelRef,
  sized,
  min,
  max,
  className,
  onStart,
  onMove,
  onEnd,
  onCancel,
  onReset,
}: LayoutSplitterProps) {
  const [dragging, setDragging] = useState(false)
  const detachRef = useRef<(() => void) | null>(null)
  useEffect(() => () => detachRef.current?.(), [])
  // 记着的尺寸会被样式按编辑器大小夹住（窄工作台里右栏让给舞台），说明里写实际排出来的尺寸
  const [actual, setActual] = useState<number | null>(null)
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const observer = new ResizeObserver(() => {
      const box = panel.getBoundingClientRect()
      setActual(Math.round(orientation === 'vertical' ? box.width : box.height))
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [panelRef, orientation])
  const along = (event: { clientX: number; clientY: number }) =>
    orientation === 'vertical' ? event.clientX : event.clientY

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    detachRef.current?.()
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const origin = along(event)
    onStart()
    setDragging(true)
    const move = (moved: globalThis.PointerEvent) => onMove(along(moved) - origin, 'pointer')
    const finish = (cancelled: boolean) => {
      detachRef.current?.()
      setDragging(false)
      if (cancelled) onCancel()
      else onEnd()
    }
    const stop = () => finish(false)
    const cancel = () => finish(true)
    const escape = (key: globalThis.KeyboardEvent) => {
      if (key.key !== 'Escape') return
      key.preventDefault()
      key.stopPropagation()
      cancel()
    }
    detachRef.current = () => {
      detachRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, { capture: true })
      window.removeEventListener('blur', cancel)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', cancel)
    // 抢在编辑器之前收 Esc：这一下只取消拖动，不再取消选中
    window.addEventListener('keydown', escape, { capture: true })
    window.addEventListener('blur', cancel)
  }

  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const [back, forth] =
      orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    const step = event.key === back ? -KEY_STEP : event.key === forth ? KEY_STEP : 0
    if (step === 0) return
    // 不再传给编辑器：方向键在这里调尺寸，不挪播放头
    event.preventDefault()
    event.stopPropagation()
    onStart()
    onMove(step, 'keyboard')
    onEnd()
  }

  const detail = [
    sized && actual !== null ? `当前 ${actual}px` : undefined,
    max === undefined ? `至少 ${min}px` : `可在 ${min}–${max}px 之间调整`,
    '双击恢复默认',
  ]
  return (
    <button
      aria-label={label}
      className={cn('wf-splitter ui-focus', dragging && 'is-dragging', className)}
      onDoubleClick={onReset}
      onKeyDown={nudge}
      onPointerDown={startDrag}
      title={`${label}（${detail.filter((part) => part !== undefined).join('，')}）`}
      type="button"
    />
  )
}
