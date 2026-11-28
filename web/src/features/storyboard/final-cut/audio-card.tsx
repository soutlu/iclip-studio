import type { PointerEvent } from 'react'
import {
  AudioCover,
  AuditionBuffering,
  audioClockText,
  audioDurationText,
  useAuditionProgress,
  useAuditionRatio,
  Waveform,
  type Audition,
} from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { Slider } from '@/shared/ui/slider'
import type { AuditionItem } from './use-tab-audition'

/**
 * 页签底部常驻的迷你试听条：封面、播放 / 暂停、名字、进度滑杆、「当前 / 总长」、✕。
 * 占自己的一行，不盖住列表的最后一行；放不出来时进度换成失败说明和「重试」。
 */
export function TabAuditionBar({ audition, item }: { audition: Audition; item: AuditionItem }) {
  const { failed } = useAuditionProgress(audition)
  const { timeMs, totalMs } = useAuditionRatio(audition, item.durationMs)
  const playing = audition.playing === item.id
  const length = Math.max(1, totalMs)
  return (
    <section aria-label={`试听：${item.title}`} className="wf-tab-dock wf-audition-dock">
      <AudioCover id={item.id} size="xs" state="idle" title={item.title} traits={item.traits}>
        <AuditionBuffering audition={audition} />
      </AudioCover>
      <IconButton
        aria-pressed={playing}
        label={playing ? '暂停' : '播放'}
        name={playing ? 'final-cut-pause' : 'final-cut-play'}
        onClick={() => audition.toggle(item.id, item.url)}
        size="xs"
      />
      <span className="wf-audition-dock-title" title={item.title}>
        {item.title}
      </span>
      {failed ? (
        <MediaFallback
          className="min-w-0 flex-1 justify-start"
          compact
          kind="audio"
          onRetry={audition.retry}
        />
      ) : (
        <>
          <Slider
            className="wf-audition-dock-slider"
            label={`播放进度：${item.title}`}
            max={length}
            min={0}
            onChange={(next) => audition.seek(next / length, totalMs)}
            step={100}
            value={Math.min(timeMs, length)}
            valueText={`${audioClockText(timeMs)} / ${audioDurationText(totalMs)}`}
          />
          <AudioClock timeMs={timeMs} totalMs={totalMs} />
        </>
      )}
      <IconButton label="关闭试听" name="close" onClick={audition.stop} size="xs" />
    </section>
  )
}

/** 「当前 / 总长」：已放到的时刻用试听进度色，后面总长淡色。 */
function AudioClock({ timeMs, totalMs }: { timeMs: number; totalMs: number }) {
  return (
    <span className="wf-audio-clock">
      <b>{audioClockText(timeMs)}</b> / {audioDurationText(totalMs)}
    </span>
  )
}

/** 试听中的那一行右边的「当前 / 总长」：只有它订阅每帧的进度。 */
export function RowClock({ audition, durationMs }: { audition: Audition; durationMs: number }) {
  const { timeMs, totalMs } = useAuditionRatio(audition, durationMs)
  return <AudioClock timeMs={timeMs} totalMs={totalMs} />
}

type AudioRowWaveProps = {
  title: string
  peaks: readonly number[]
  audition: Audition
  /** 这一行是不是当前试听的那条（在放或暂停着）。 */
  current: boolean
  durationMs: number
  /** 点没在试听的这一行的波形：从点到的比例处开始试听。 */
  onStartAt: (ratio: number) => void
}

/**
 * 配乐行名字下面的对称波形：当前试听的那条按进度染色、能点能拖着跳（方向键前后跳）；
 * 别的行点波形任意位置从那里开始试听。
 */
export function AudioRowWave({
  title,
  peaks,
  audition,
  current,
  durationMs,
  onStartAt,
}: AudioRowWaveProps) {
  if (current)
    return <PlayingWave audition={audition} durationMs={durationMs} peaks={peaks} title={title} />
  const start = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width > 0) onStartAt(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)))
  }
  // 键盘从封面的试听键开始；这里只给指针一个顺手的入口
  return (
    <span aria-hidden className="wf-media-wave is-idle" onPointerDown={start}>
      <Waveform className="wf-media-wave-bars" peaks={peaks} />
    </span>
  )
}

function PlayingWave({
  title,
  peaks,
  audition,
  durationMs,
}: Omit<AudioRowWaveProps, 'current' | 'onStartAt'>) {
  const { ratio, totalMs } = useAuditionRatio(audition, durationMs)
  return (
    <Waveform
      className="wf-media-wave"
      peaks={peaks}
      progress={ratio}
      seek={{
        durationMs: totalMs,
        label: `播放进度：${title}`,
        onSeek: (next) => audition.seek(next, totalMs),
      }}
    />
  )
}
