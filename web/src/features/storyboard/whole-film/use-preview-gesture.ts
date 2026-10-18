import { useRef, useState, type PointerEvent } from 'react'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import type { WholeFilmDraft } from './editing/draft'
import type { EditResult } from './editing/result'

type Gesture = {
  pointerId: number
  originX: number
  compute: (deltaPx: number) => EditResult
  moved: boolean
  last: EditResult | undefined
}

/**
 * 一次拖动是一步编辑：按下时记住当时的草稿（由 `compute` 闭包带着），拖动中按累计位移算出预览，
 * 松手时只提交最后那一次结果。拖动没超过阈值算点按，不提交。
 */
export function usePreviewGesture(onCommit: (result: EditResult) => void) {
  const [preview, setPreview] = useState<WholeFilmDraft | null>(null)
  const gestureRef = useRef<Gesture | null>(null)

  const start = (event: PointerEvent<HTMLElement>, compute: Gesture['compute']) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      compute,
      moved: false,
      last: undefined,
    }
  }

  const move = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    const deltaPx = event.clientX - gesture.originX
    if (!gesture.moved && Math.abs(deltaPx) <= DRAG_THRESHOLD) return
    gesture.moved = true
    gesture.last = gesture.compute(deltaPx)
    setPreview(gesture.last.ok ? gesture.last.draft : null)
  }

  /** 松手；返回这一下算不算拖动（不算就当点按处理） */
  const end = (event: PointerEvent<HTMLElement>): boolean => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return false
    releasePointer(event)
    gestureRef.current = null
    setPreview(null)
    if (gesture.moved && gesture.last?.ok === true) onCommit(gesture.last)
    return gesture.moved
  }

  const cancel = () => {
    gestureRef.current = null
    setPreview(null)
  }

  return { preview, start, move, end, cancel }
}
