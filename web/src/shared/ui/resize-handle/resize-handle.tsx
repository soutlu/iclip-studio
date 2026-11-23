import { useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'

const RESIZE_HANDLE_WIDTH = 8
const KEY_STEP = 16

export type ResizeInput = 'pointer' | 'keyboard'

type ResizeHandleProps = {
  label: string
  position?: number
  value: number
  min: number
  max: number
  onResizeStart: () => void
  onResize: (delta: number, input: ResizeInput) => void
  onResizeEnd: () => void
  onResizeCancel: () => void
  onReset: () => void
}

export function ResizeHandle({
  label,
  position = 0,
  max,
  min,
  onReset,
  onResize,
  onResizeEnd,
  onResizeCancel,
  onResizeStart,
  value,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  const detachRef = useRef<(() => void) | null>(null)
  useEffect(() => () => detachRef.current?.(), [])

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    detachRef.current?.()
    detachRef.current = null
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const origin = event.clientX
    onResizeStart()
    setDragging(true)
    const move = (moved: PointerEvent) => onResize(moved.clientX - origin, 'pointer')
    const stop = () => finish(false)
    const cancel = () => finish(true)
    const keydown = (key: KeyboardEvent) => {
      if (key.key === 'Escape') {
        key.preventDefault()
        cancel()
      }
    }
    const finish = (cancelled: boolean) => {
      detachRef.current?.()
      detachRef.current = null
      setDragging(false)
      if (cancelled) onResizeCancel()
      else onResizeEnd()
    }
    detachRef.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('blur', cancel)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', keydown)
    window.addEventListener('blur', cancel)
  }

  const nudge = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0
    if (step === 0) return
    event.preventDefault()
    onResizeStart()
    onResize(step, 'keyboard')
    onResizeEnd()
  }

  return (
    <button
      aria-label={label}
      className="group layer-sidebar absolute inset-y-0 cursor-col-resize touch-none ui-focus select-none"
      onDoubleClick={onReset}
      onKeyDown={nudge}
      onPointerDown={startDrag}
      style={{ left: position - RESIZE_HANDLE_WIDTH / 2, width: RESIZE_HANDLE_WIDTH }}
      title={`${label}（当前 ${value}px，拖动可在 ${min}–${max}px 之间调整，双击可恢复默认）`}
      type="button"
    >
      <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
      {/* 悬停、聚焦或拖动时居中显现短握把，与 final-cut 编辑器分隔条保持一致 */}
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 left-1/2 w-0.75 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[height,background-color] duration-(--dur-s) ease-(--ease)',
          dragging
            ? 'h-13 bg-on-surface-muted'
            : 'h-8.5 group-hover:h-13 group-hover:bg-on-surface-muted group-focus-visible:h-13 group-focus-visible:bg-on-surface-muted',
        )}
      />
    </button>
  )
}
