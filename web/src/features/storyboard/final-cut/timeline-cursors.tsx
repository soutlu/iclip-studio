import { useEffect, useEffectEvent, useState, type RefObject } from 'react'
import { cn } from '@/shared/lib/utils'
import { timeLabel } from '../editing/time-label'
import { TimelinePlayhead } from '../editing/timeline'
import { usePlayheadClock, type PlayheadClock } from './playhead-clock'
import { msToPx, pxToMs } from './timeline-scale'

/** 时间线播放头竖线：直接订阅播放头实时时钟，播放期间逐帧重绘自身。 */
export function FilmPlayhead({
  clock,
  totalMs,
  pps,
  dragging,
}: {
  clock: PlayheadClock
  totalMs: number
  pps: number
  dragging: boolean
}) {
  const ms = usePlayheadClock(clock)
  return (
    <TimelinePlayhead dragging={dragging} style={{ left: msToPx(Math.min(ms, totalMs), pps) }} />
  )
}

// 悬停游标离时间区两头不到这么多像素时，读数气泡贴着游标往里排，不伸到行头底下、时间区外面（约半个气泡宽）
const SKIM_EDGE = 36

/**
 * 悬停游标：指针在时间尺和各行上移动（没按着键）时，一条细虚线跟着它往下穿过各行，时间尺上一个小气泡写这个位置的
 * 时间（写法同播放条的时间码）；切开工具下（`razor`）画成实线切分线。只是显示：不定位、不挡点选和拖动。
 * `place` 把指针下的时间换成画在哪（开着吸附时吸上去；切开工具下就是会切开的地方），不画时答 null；`quiet`
 * 时（拖片段、框选、拖播放头）不画。自己听时间区的指针事件、自己记位置，指针动时只重画它自己。
 */
export function Skimmer({
  contentRef,
  pps,
  razor,
  quiet,
  place,
}: {
  contentRef: RefObject<HTMLDivElement | null>
  pps: number
  razor: boolean
  quiet: boolean
  place: (ms: number) => number | null
}) {
  // 画在哪（毫秒）和时间区当时有多宽（像素，读数气泡靠边时不伸出去）
  const [at, setAt] = useState<{ ms: number; width: number } | null>(null)
  const follow = useEffectEvent((event: globalThis.PointerEvent) => {
    const content = contentRef.current
    // 按着键是在拖东西（片段、播放头、时间尺、框选）；触摸没有悬停
    if (content === null || event.buttons !== 0 || event.pointerType === 'touch') {
      setAt(null)
      return
    }
    const ms = place(pxToMs(event.clientX - content.getBoundingClientRect().left, pps))
    setAt(ms === null ? null : { ms, width: content.clientWidth })
  })
  useEffect(() => {
    const content = contentRef.current
    if (content === null) return
    const hide = () => setAt(null)
    const move = (event: globalThis.PointerEvent) => follow(event)
    // 离开时间区：pointerleave 不冒泡，按 pointerout 去的地方判断，在时间区里面的子元素之间挪不算
    const out = (event: globalThis.PointerEvent) => {
      if (!(event.relatedTarget instanceof Node && content.contains(event.relatedTarget))) hide()
    }
    content.addEventListener('pointermove', move)
    content.addEventListener('pointerdown', hide)
    content.addEventListener('pointerout', out)
    return () => {
      content.removeEventListener('pointermove', move)
      content.removeEventListener('pointerdown', hide)
      content.removeEventListener('pointerout', out)
    }
  }, [contentRef])
  if (at === null || quiet) return null
  const left = msToPx(at.ms, pps)
  return (
    <>
      <span
        aria-hidden="true"
        className={cn('wf-skimmer', razor && 'is-razor')}
        data-testid="timeline-skimmer"
        style={{ left }}
      />
      <span
        aria-hidden="true"
        className="wf-skimmer-time"
        data-align={left < SKIM_EDGE ? 'start' : left > at.width - SKIM_EDGE ? 'end' : undefined}
        data-testid="timeline-skimmer-time"
        style={{ left }}
      >
        {timeLabel(at.ms / 1000)}
      </span>
    </>
  )
}
