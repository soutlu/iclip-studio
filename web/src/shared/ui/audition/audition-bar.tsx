import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MediaBuffering } from '@/shared/ui/media-buffering'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { AuditionButton } from './audio-cover'
import { audioClockText, audioDurationText } from './audio-labels'
import { useAuditionProgress, type Audition } from './use-audition'
import { Waveform } from './waveform'

/** 等数据时盖在试听键、封面上的提示：只有当前这条要订阅进度。 */
export function AuditionBuffering({ audition }: { audition: Audition }) {
  const { waiting } = useAuditionProgress(audition)
  return waiting ? <MediaBuffering compact /> : null
}

/** 当前这条已放过的比例（0～1）；总时长先用条目自己的，读到真实时长后用真实的。 */
export function useAuditionRatio(audition: Audition, durationMs: number) {
  const { timeMs, durationMs: measured } = useAuditionProgress(audition)
  const total = measured ?? durationMs
  return { ratio: total > 0 ? Math.min(1, timeMs / total) : 0, timeMs, totalMs: total }
}

/** 名称下面那条细进度线：只挂在当前这条（在放或暂停着）上，它订阅每帧的进度。 */
export function AuditionProgressLine({
  audition,
  durationMs,
  className,
}: {
  audition: Audition
  durationMs: number
  className?: string | undefined
}) {
  const { ratio } = useAuditionRatio(audition, durationMs)
  return (
    <span aria-hidden className={cn('block h-0.5 w-full rounded-full bg-hairline', className)}>
      <span
        className="block h-full rounded-full bg-on-surface"
        style={{ width: `${String(ratio * 100)}%` }}
      />
    </span>
  )
}

type AuditionBarProps = {
  audition: Audition
  title: string
  /** 标题下那一行灰字，如属性摘要；紧凑样子不显示。 */
  detail?: string
  peaks: readonly number[] | null
  durationMs: number
  /** 暂停或续放当前这条。 */
  onToggle: () => void
  /** 紧凑样子：单行、贴着所在面板的底边（上面一条细线），给窄的侧栏用。 */
  compact?: boolean
}

/**
 * 试听条：浮在列表底部的白色圆角条，放着、暂停着都在，点 ✕ 才收起（`stop`）。
 * 能看到放到哪、拖着波形跳；等数据时试听键上转圈，放不出来时显示失败和「重试」。
 */
export function AuditionBar({
  audition,
  title,
  detail = '',
  peaks,
  durationMs,
  onToggle,
  compact = false,
}: AuditionBarProps) {
  const { failed } = useAuditionProgress(audition)
  const { ratio, timeMs, totalMs } = useAuditionRatio(audition, durationMs)
  const playing = audition.playing !== null
  return (
    <section
      aria-label={`试听：${title}`}
      className={cn(
        'flex w-full items-center',
        compact
          ? 'gap-2.5 border-t border-hairline bg-card py-1.5 pr-1.5 pl-3'
          : 'gap-3 rounded-lg bg-card py-2.5 pr-2.5 pl-3 shadow-2 ring-1 ring-hairline sm:gap-4',
      )}
    >
      <AuditionButton
        className={compact ? 'size-7' : undefined}
        ink
        label={playing ? '暂停' : '播放'}
        onToggle={onToggle}
        playing={playing}
      >
        <AuditionBuffering audition={audition} />
      </AuditionButton>
      <div className={cn('min-w-0', compact ? 'max-w-32 shrink' : 'w-28 shrink-0 sm:w-44')}>
        <p
          className={cn(
            'truncate font-medium text-on-surface',
            compact ? 'text-label' : 'text-body-sm',
          )}
          title={compact ? title : undefined}
        >
          {title}
        </p>
        {compact || detail === '' ? null : (
          <p className="truncate text-caption text-on-surface-faint">{detail}</p>
        )}
      </div>
      {failed ? (
        <MediaFallback
          className="min-w-0 flex-1 justify-start"
          compact
          kind="audio"
          onRetry={audition.retry}
        />
      ) : (
        <>
          <span className="shrink-0 text-caption text-on-surface tabular-nums max-sm:hidden">
            {audioClockText(timeMs)}
          </span>
          <Waveform
            className="min-w-0 flex-1"
            peaks={peaks}
            progress={ratio}
            seek={{
              durationMs: totalMs,
              label: `播放进度：${title}`,
              onSeek: (ratio) => audition.seek(ratio, totalMs),
            }}
          />
          <span className="shrink-0 text-caption text-on-surface-faint tabular-nums max-sm:hidden">
            {audioDurationText(totalMs)}
          </span>
        </>
      )}
      <IconButton label="关闭试听" name="close" onClick={audition.stop} size="sm" />
    </section>
  )
}
