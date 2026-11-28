import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useAuditionRatio, Waveform, type Audition } from '@/shared/ui/audition'

/** 常驻的「✓ 已用」「✓ 当前」小徽标：镜头的出片行、配乐行、音色行共用。 */
export function UsedBadge({ children }: { children: string }) {
  return (
    <span className="wf-used-badge">
      <Icon decorative name="final-cut-in-use" size="xs" />
      {children}
    </span>
  )
}

type MediaRowProps = {
  /** 盖满整行的按钮（加 `wf-row-hit` 类）：点、拖、右键整行都落在它上面，别的控件叠在它上面。 */
  hit?: ReactNode
  /** 左边的封面（一般是 `AudioCover`，点了试听 / 暂停）。 */
  cover: ReactNode
  title: string
  /** 名字下面一行：配乐是对称波形，音色是「语种 · 性别 · 场景」。 */
  detail?: ReactNode
  /** 右边那一列平时显示的：时长；试听中是「当前 / 总长」。 */
  end?: ReactNode
  /** 右边那一列的操作按钮：按意图显露（见 `.wf-reveal`），显出来时换下 `end`。 */
  actions?: ReactNode
  /** 排在最右、常驻的小徽标（`UsedBadge`）。 */
  badge?: ReactNode
  /** 选中或正在试听：行底色加深一档。 */
  current?: boolean
  className?: string
  /** 名字和下面一行之后再排的东西，如 `RowProgress`。 */
  children?: ReactNode
}

/**
 * 侧栏列表的媒体行：左边封面、中间名字和下面一行、右边对齐的一列（时长 / 悬停时的操作）和常驻徽标。
 * 行底色按 `.wf-row` 的状态走（悬停很浅、选中稍深），没有外框和竖条；点选不引起排版跳动。
 */
export function MediaRow({
  hit,
  cover,
  title,
  detail,
  end,
  actions,
  badge,
  current = false,
  className,
  children,
}: MediaRowProps) {
  return (
    <li className={cn('wf-row wf-reveal-host wf-media-row', current && 'is-current', className)}>
      {hit}
      <span className="wf-media-cover">{cover}</span>
      <span className="wf-media-text">
        <span className="wf-media-title" title={title}>
          {title}
        </span>
        {detail}
        {children}
      </span>
      {end === undefined && actions === undefined ? null : (
        <span className="wf-media-end">
          {end === undefined ? null : (
            <span className={cn('wf-media-rest', actions !== undefined && 'wf-reveal-rest')}>
              {end}
            </span>
          )}
          {actions === undefined ? null : <span className="wf-reveal">{actions}</span>}
        </span>
      )}
      {badge}
    </li>
  )
}

type RowProgressProps = {
  audition: Audition
  /** 这一行是不是当前试听的那条（在放或暂停着）：是就展开。 */
  current: boolean
  /** 条目自己记的时长；读到音频后按真实时长算。 */
  durationMs: number
  /** 进度条的无障碍名，如「播放进度：Emma」。 */
  label: string
}

/**
 * 行内试听进度条：正在试听这一行时平滑展开成一条细线，点、拖任意位置跳过去，方向键前后跳；停了收起。
 * 收起时只留一条不订阅进度的占位，展开收起都是高度过渡，不跳排版。
 */
export function RowProgress({ audition, current, durationMs, label }: RowProgressProps) {
  return (
    <span className="wf-row-progress" data-open={current ? '' : undefined}>
      <span className="wf-row-progress-body">
        {current ? (
          <LiveProgress audition={audition} durationMs={durationMs} label={label} />
        ) : (
          <span className="wf-row-progress-idle" />
        )}
      </span>
    </span>
  )
}

function LiveProgress({ audition, durationMs, label }: Omit<RowProgressProps, 'current'>) {
  const { ratio, totalMs } = useAuditionRatio(audition, durationMs)
  return (
    <Waveform
      className="wf-row-progress-line"
      peaks={null}
      progress={ratio}
      seek={{ durationMs: totalMs, label, onSeek: (next) => audition.seek(next, totalMs) }}
    />
  )
}
