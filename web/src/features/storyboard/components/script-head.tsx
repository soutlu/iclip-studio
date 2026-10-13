/** 文案列的列头与时长胶囊，分镜页与制作页共用。列头写镜头数与总长，带「收起为摘要」开关和按时长切分的镜头条
 * （色段与左轨短色签同取镜头的点缀色），点一段跳到那个镜头。版式见 storyboard.css 的「文案列」一节。 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { ShotAccent } from '../shot-accent'
import { formatTimeRange, formatTimecode, type SegmentTime } from '../shot-content'

/** 镜头条上的一段。 */
export type ScriptScene = { id: string; label: string; time: SegmentTime; accent: ShotAccent }

type ScriptHeadProps = {
  scenes: readonly ScriptScene[]
  /** 总长：最后一镜的止秒。 */
  total: number
  selectedId: string | undefined
  compact: boolean
  onToggleCompact: () => void
  onJump: (id: string) => void
}

export function ScriptHead({
  compact,
  onJump,
  onToggleCompact,
  scenes,
  selectedId,
  total,
}: ScriptHeadProps) {
  return (
    <div className="storyboard-script-head">
      <div className="flex min-h-7 items-center gap-2">
        <p className="min-w-0 text-body-sm text-on-surface-muted tabular-nums">
          <span className="text-body font-semibold text-on-surface">{scenes.length} 个镜头</span>
          {` · 共 ${formatTimecode(total)}`}
        </p>
        <Button
          className="ml-auto h-7 px-2.5 text-label text-on-surface-variant"
          onClick={onToggleCompact}
          size="md"
          variant="ghost"
        >
          {compact ? '显示全文' : '收起为摘要'}
        </Button>
      </div>
      <div aria-label="镜头时间条" className="storyboard-timeline" role="group">
        {scenes.map(({ accent, id, label, time }) => {
          const summary = [label, formatTimecode(time.duration), formatTimeRange(time)]
          return (
            <TooltipRoot key={id}>
              <TooltipTrigger asChild>
                <button
                  aria-current={id === selectedId}
                  aria-label={summary.join('，')}
                  className={cn('storyboard-timeline-segment ui-focus', accent.segment)}
                  onClick={() => onJump(id)}
                  // 按原始起止秒排比例，不用取整后的时长。
                  style={{ flexGrow: time.end - time.start }}
                  type="button"
                />
              </TooltipTrigger>
              <TooltipContent>{summary.join(' · ')}</TooltipContent>
            </TooltipRoot>
          )
        })}
      </div>
      <div aria-hidden className="storyboard-timeline-ticks">
        <span>{formatTimecode(0)}</span>
        <span>{formatTimecode(total)}</span>
      </div>
    </div>
  )
}

/** 时长胶囊：显示时长，悬停提示与读屏给完整区间。 */
export function DurationPill({ time }: { time: SegmentTime }) {
  const range = formatTimeRange(time)
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span className="storyboard-duration">
          <Icon decorative name="duration" size="xs" />
          {formatTimecode(time.duration)}
          <span className="sr-only">，{range}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{range}</TooltipContent>
    </TooltipRoot>
  )
}
