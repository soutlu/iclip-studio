import { cn } from '@/shared/lib/utils'
import type { TimelineBeat } from './music-beats'
import { msToPx } from './timeline-scale'

/**
 * 配乐片段上的节拍：贴着片段底边一排细竖线，强拍更高、更实。画的就是拖动、裁剪时能吸上去的那些节拍
 * （见 `shownBeats`）；`startMs` 是片段现在的开头，竖线按它排。
 */
export function BeatMarks({
  beats,
  startMs,
  pps,
}: {
  beats: readonly TimelineBeat[]
  startMs: number
  pps: number
}) {
  if (beats.length === 0) return null
  return (
    <span aria-hidden="true" className="wf-beat-marks" data-testid="beat-marks">
      {beats.map((beat) => (
        <span
          className={cn('wf-beat', beat.strong && 'is-strong')}
          key={beat.ms}
          style={{ left: msToPx(beat.ms - startMs, pps) }}
        />
      ))}
    </span>
  )
}
