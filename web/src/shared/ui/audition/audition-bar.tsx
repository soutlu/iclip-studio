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

type AuditionBarProps = {
  audition: Audition
  title: string
  /** 标题下那一行灰字，如属性摘要。 */
  detail: string
  peaks: readonly number[] | null
  durationMs: number
  /** 暂停或续放当前这条。 */
  onToggle: () => void
}

/**
 * 试听条：浮在列表底部的白色圆角条，放着、暂停着都在，点 ✕ 才收起（`stop`）。
 * 能看到放到哪、拖着波形跳；等数据时试听键上转圈，放不出来时显示失败和「重试」。
 */
export function AuditionBar({
  audition,
  title,
  detail,
  peaks,
  durationMs,
  onToggle,
}: AuditionBarProps) {
  const { failed } = useAuditionProgress(audition)
  const { ratio, timeMs, totalMs } = useAuditionRatio(audition, durationMs)
  const playing = audition.playing !== null
  return (
    <section
      aria-label={`试听：${title}`}
      className="flex w-full items-center gap-3 rounded-lg bg-card py-2.5 pr-2.5 pl-3 shadow-2 ring-1 ring-hairline sm:gap-4"
    >
      <AuditionButton ink label={playing ? '暂停' : '播放'} onToggle={onToggle} playing={playing}>
        <AuditionBuffering audition={audition} />
      </AuditionButton>
      <div className="w-28 min-w-0 shrink-0 sm:w-44">
        <p className="truncate text-body-sm font-medium text-on-surface">{title}</p>
        {detail === '' ? null : (
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
