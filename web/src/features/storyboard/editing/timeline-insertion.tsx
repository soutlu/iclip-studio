import {
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/shared/lib/utils'
import type { MotionSnapshot, useInsertionMotion } from './use-insertion-motion'
import './timeline.css'

export type InsertionFace = { title: string; media: ReactNode; durationMs: number }
export type InsertionBox = { left: number; top: number; width: number; height: number }
export type InsertionMotion = ReturnType<typeof useInsertionMotion>
export type InsertionPreviewHandle = { snapshot: () => MotionSnapshot | undefined }
export type InsertionGhostHandle = { follow: (x: number, y: number) => void }

const ghostPosition = (x: number, y: number) => ({
  x: Math.max(8, Math.min(window.innerWidth - 166, x + 14)),
  y: Math.max(8, Math.min(window.innerHeight - 60, y + 36)),
})

/** 拖到时间线上的东西共用的紧凑缩影；按住时坐标直接跟手，松手后才缓动到落点或来源。 */
export function InsertionGhost({
  face,
  motion,
  clientX,
  clientY,
  destination,
  blocked,
  onRest,
  ref,
}: {
  face: InsertionFace
  motion: InsertionMotion
  clientX: number
  clientY: number
  destination: InsertionBox | undefined
  blocked: boolean
  onRest: () => void
  ref: Ref<InsertionGhostHandle>
}) {
  const localRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef({ x: clientX, y: clientY })
  const complete = useEffectEvent(onRest)
  useImperativeHandle(
    ref,
    () => ({
      follow: (x, y) => {
        pointerRef.current = { x, y }
        if (localRef.current !== null)
          motion.move(localRef.current, ghostPosition(x, y), { immediate: true })
      },
    }),
    [motion],
  )
  useLayoutEffect(() => {
    const node = localRef.current
    if (node === null) return
    if (destination !== undefined) {
      motion.move(
        node,
        {
          x: destination.left + Math.max(0, (destination.width - 158) / 2),
          y: destination.top + Math.max(0, (destination.height - 52) / 2),
          opacity: 0,
          scale: 0.97,
        },
        { onRest: complete },
      )
      return
    }
    const position = ghostPosition(pointerRef.current.x, pointerRef.current.y)
    if (motion.read(node) === undefined) {
      motion.seed(node, {
        value: { ...position, opacity: 0.65, scale: 0.97 },
        velocity: {},
      })
    }
    motion.move(node, position, { immediate: true })
    motion.move(node, { opacity: blocked ? 0.66 : 1, scale: 1 })
  }, [motion, destination, blocked])
  return createPortal(
    <div
      aria-hidden="true"
      className={cn('timeline-insertion-ghost', blocked && 'is-blocked')}
      ref={localRef}
    >
      <span className="timeline-insertion-thumb">{face.media}</span>
      <span className="timeline-insertion-details">
        <span>{face.title}</span>
        <small>{(face.durationMs / 1000).toFixed(1)} 秒</small>
      </span>
    </div>,
    document.body,
  )
}

export type InsertionPreviewPosition = {
  x: number
  y: number
  width: number
  height: number
  text: string
  blocked: boolean
  alignEnd: boolean
}

/** 占位长度等于完整时长，内部颜色表示可放置；各条轨使用相同结构。 */
export function InsertionPreview({
  face,
  position,
  motion,
  elementRef,
}: {
  face: InsertionFace | undefined
  position: InsertionPreviewPosition | undefined
  motion: InsertionMotion
  elementRef: Ref<InsertionPreviewHandle>
}) {
  const localRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(
    elementRef,
    () => ({
      snapshot: () => (localRef.current === null ? undefined : motion.read(localRef.current)),
    }),
    [motion],
  )
  useLayoutEffect(() => {
    const node = localRef.current
    if (node === null) return
    if (position === undefined) {
      motion.move(
        node,
        { opacity: 0 },
        {
          onRest: () => {
            node.hidden = true
          },
        },
      )
      return
    }
    const { x, y, width, height } = position
    if (node.hidden) motion.seed(node, { value: { x, y, width, height, opacity: 0 }, velocity: {} })
    node.hidden = false
    motion.move(node, { x, y, width, height, opacity: 1 })
  }, [motion, position])
  return (
    <div
      className={cn('timeline-insertion-preview', position?.blocked && 'is-blocked')}
      data-testid="timeline-insertion-preview"
      hidden
      ref={localRef}
    >
      <span aria-hidden="true" className="timeline-insertion-surface">
        <span className="timeline-insertion-thumb">{face?.media}</span>
        <span className="timeline-insertion-name">
          {face?.title} · {((face?.durationMs ?? 0) / 1000).toFixed(1)} 秒
        </span>
      </span>
      {position === undefined ? null : (
        <span className={cn('timeline-insertion-tip', position.alignEnd && 'is-end')} role="status">
          {position.text}
        </span>
      )}
    </div>
  )
}
