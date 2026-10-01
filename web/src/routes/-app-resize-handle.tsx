/** 拖动监听 window，防止指针离开拖柄后中断；仅上报相对位移，宽度与边界由壳管理。 */

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { APP_RESIZE_HANDLE_WIDTH, type ResizeInput } from './-app-shell-layout'

const KEY_STEP = 16

type AppResizeHandleProps = {
  label: string
  position?: number
  /** 当前宽度用于可访问说明。 */
  value: number
  min: number
  max: number
  /** 开始拖动时记录基准宽度。 */
  onResizeStart: () => void
  onResize: (delta: number, input: ResizeInput) => void
  onResizeEnd: () => void
  onResizeCancel: () => void
  onReset: () => void
}

export function AppResizeHandle({
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
}: AppResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  // 卸载时清理 window 监听器，避免拖动状态残留。
  const detachRef = useRef<(() => void) | null>(null)
  useEffect(() => () => detachRef.current?.(), [])

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    // 上一轮的 pointerup 可能丢失（触屏多指、指针被系统接管），先摘掉旧监听，重复按下即自愈。
    detachRef.current?.()
    detachRef.current = null
    event.preventDefault()
    // 拖动后正文可能被裁切，让键盘焦点留在始终可见的边界上。
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
    // 使用原生 button 提供键盘交互；jsx-a11y 将 separator 视为非交互角色。
    <button
      aria-label={label}
      className="group layer-sidebar absolute inset-y-0 cursor-col-resize touch-none ui-focus select-none"
      onDoubleClick={onReset}
      onKeyDown={nudge}
      onPointerDown={startDrag}
      style={{ left: position - APP_RESIZE_HANDLE_WIDTH / 2, width: APP_RESIZE_HANDLE_WIDTH }}
      title={`${label}（当前 ${value}px，可拖动 ${min}–${max}，双击恢复默认）`}
      type="button"
    >
      {/* 热区覆盖边界；分隔线自身不占列宽。 */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ui-motion-s',
          dragging ? 'bg-border-hover' : 'bg-border group-hover:bg-border-hover',
        )}
      />
    </button>
  )
}
