import { Slider } from 'radix-ui'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { timeLabel } from '../editing/time-label'
import { Keys, Tool } from './editor-toolbar'

type PreviewTransportProps = {
  playheadMs: number
  totalMs: number
  buffered: readonly TimeSpan[]
  playBlocked: string | undefined
  playing: boolean
  onPlay: () => void
  onSeek: (ms: number) => void
}

// 方向键每次走这么多，按住 Shift 是它的十倍；和编辑器里不在进度条上时的方向键一致
const STEP_SECONDS = 0.1

/** 预览下面的播放条：成片的进度条、时间和播放键。 */
export function PreviewTransport({
  playheadMs,
  totalMs,
  buffered,
  playBlocked,
  playing,
  onPlay,
  onSeek,
}: PreviewTransportProps) {
  const total = totalMs / 1000
  const time = Math.min(playheadMs, totalMs) / 1000
  const percent = (seconds: number) => `${(seconds / total) * 100}%`
  const playLabel = playing ? '暂停' : '播放'
  return (
    <div aria-label="播放控制" className="wf-transport" role="group">
      <Slider.Root
        className="wf-seek"
        disabled={total <= 0}
        max={total > 0 ? total : 1}
        onValueChange={([at]) => {
          if (at !== undefined) onSeek(Math.round(at * 1000))
        }}
        step={STEP_SECONDS}
        value={[time]}
      >
        <Slider.Track className="wf-seek-track">
          {total > 0
            ? buffered.map(({ start, end }) => (
                <span
                  aria-hidden="true"
                  className="wf-seek-buffered"
                  data-testid="preview-buffered"
                  key={start}
                  style={{ left: percent(start), width: percent(Math.min(end, total) - start) }}
                />
              ))
            : null}
          <Slider.Range className="wf-seek-range" />
        </Slider.Track>
        <Slider.Thumb
          aria-label="播放进度"
          aria-valuetext={`${timeLabel(time)} / ${timeLabel(total)}`}
          className="wf-seek-thumb ui-focus"
        />
      </Slider.Root>
      <div className="wf-transport-row">
        <span className="wf-clock">
          {timeLabel(time)} <span>/ {timeLabel(total)}</span>
        </span>
        <Tool
          blocked={playBlocked}
          className="wf-play"
          icon={playing ? 'pause' : 'play'}
          label={playLabel}
          onClick={onPlay}
          shortcuts="Space"
          tip={
            <>
              {playLabel}
              <Keys>空格</Keys>
            </>
          }
        />
      </div>
    </div>
  )
}
