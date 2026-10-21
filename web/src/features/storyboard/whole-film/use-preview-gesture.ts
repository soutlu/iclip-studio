import { useRef, useState, type PointerEvent } from 'react'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import type { WholeFilmDraft } from './editing/draft'
import type { OverlayRow } from './editing/overlays'
import type { EditResult } from './editing/result'

/** 拖到某处时算出的一步：编辑结果，以及拖动中要画的吸附线、停住的原因、特效块要去的行 */
export type GestureStep = {
  result: EditResult
  guideMs?: number | null
  /** 拖不过去的原因（如到了成片总长上限），拖动中写在旁边 */
  note?: string | undefined
  /** 原因写在哪个时刻上方 */
  noteAtMs?: number | undefined
  /** 拖动特效块时它要去的行：轨道上的行先不变，松手才换 */
  row?: OverlayRow | undefined
  /** 正在挪的特效块 */
  overlayId?: string | undefined
}

/** 拖动中的样子：上一个放得下的结果，与这一刻的提示 */
export type GesturePreview = {
  draft: WholeFilmDraft
  guideMs: number | null
  note: string | undefined
  noteAtMs: number | undefined
  row: OverlayRow | undefined
  overlayId: string | undefined
}

type Gesture = {
  pointerId: number
  originX: number
  originY: number
  /** 横向的累计位移，与指针现在的纵坐标（换行的拖动按它算落在哪一行） */
  compute: (deltaPx: number, clientY: number) => GestureStep
  moved: boolean
  /** 上一个放得下的结果；拖到放不下的地方时停在这里 */
  last: GestureStep | undefined
}

/**
 * 一次拖动是一步编辑：按下时记住当时的草稿（由 `compute` 闭包带着），拖动中按累计位移算出预览，
 * 放不下的位置不去、停在上一个放得下的地方；松手时只提交那一次结果。拖动没超过阈值算点按，不提交。
 */
export function usePreviewGesture(onCommit: (result: EditResult) => void) {
  const [preview, setPreview] = useState<GesturePreview | null>(null)
  const gestureRef = useRef<Gesture | null>(null)

  const start = (event: PointerEvent<HTMLElement>, compute: Gesture['compute']) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      compute,
      moved: false,
      last: undefined,
    }
  }

  const move = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    const deltaPx = event.clientX - gesture.originX
    const deltaY = event.clientY - gesture.originY
    if (!gesture.moved && Math.max(Math.abs(deltaPx), Math.abs(deltaY)) <= DRAG_THRESHOLD) return
    gesture.moved = true
    const step = gesture.compute(deltaPx, event.clientY)
    if (step.result.ok) gesture.last = step
    const shown = gesture.last
    if (shown === undefined || !shown.result.ok) {
      setPreview(null)
      return
    }
    setPreview({
      draft: shown.result.draft,
      guideMs: step.result.ok ? (step.guideMs ?? null) : null,
      note: step.note,
      noteAtMs: step.noteAtMs ?? shown.noteAtMs,
      row: shown.row,
      overlayId: shown.overlayId,
    })
  }

  /** 松手；返回这一下算不算拖动（不算就当点按处理） */
  const end = (event: PointerEvent<HTMLElement>): boolean => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return false
    releasePointer(event)
    gestureRef.current = null
    setPreview(null)
    if (gesture.moved && gesture.last?.result.ok === true) onCommit(gesture.last.result)
    return gesture.moved
  }

  const cancel = () => {
    gestureRef.current = null
    setPreview(null)
  }

  return { preview, start, move, end, cancel }
}
