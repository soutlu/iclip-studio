import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { useElementSize } from '@/shared/lib/use-element-size'
import { cn } from '@/shared/lib/utils'
import { audioClockText } from './audio-labels'

// 静音段也留一点高度，波形不断成空白
const MIN_LEVEL = 0.08

// 竖条线宽与每根至少占的宽度（px）；再窄也至少画这么多根
const BAR_WIDTH = 1.5
const BAR_PITCH = 3
const MIN_BARS = 16

// 方向键一次前后跳几秒
const KEY_STEP_MS = 5_000

type WaveformSeek = {
  /** 无障碍名，如「播放进度：Gravity」。 */
  label: string
  durationMs: number
  onSeek: (ratio: number) => void
}

type WaveformProps = {
  /** 归一到 0～1 的峰值；null 时不画（能拖时退成一条细进度线）。 */
  peaks: readonly number[] | null
  /** 已放过的比例（0～1），这部分用正文色，其余淡色。 */
  progress?: number
  /** 给了就能点、拖着跳，方向键前后跳几秒。 */
  seek?: WaveformSeek | undefined
  className?: string | undefined
}

/** 一段音频的波形：上下对称的细竖条，随宽度伸缩。 */
export function Waveform({ peaks, progress = 0, seek, className }: WaveformProps) {
  if (seek === undefined)
    return peaks === null ? null : (
      <WaveBars className={className} peaks={peaks} progress={progress} />
    )
  return (
    <SeekArea className={className} progress={progress} seek={seek}>
      {peaks === null ? (
        <span className="relative h-0.5 w-full overflow-hidden rounded-full bg-outline-variant">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-on-surface"
            style={{ width: `${String(progress * 100)}%` }}
          />
        </span>
      ) : (
        <WaveBars className="size-full" peaks={peaks} progress={progress} />
      )}
    </SeekArea>
  )
}

/** 把峰值并成 `count` 根（比原来少时，每根取所并各段的最大值）。 */
const binned = (peaks: readonly number[], count: number) =>
  count >= peaks.length
    ? peaks
    : Array.from({ length: count }, (_, index) =>
        Math.max(
          ...peaks.slice(
            Math.floor((index * peaks.length) / count),
            Math.floor(((index + 1) * peaks.length) / count),
          ),
        ),
      )

function WaveBars({
  peaks,
  progress,
  className,
}: {
  peaks: readonly number[]
  progress: number
  className?: string | undefined
}) {
  const [ref, { width }] = useElementSize<HTMLSpanElement>()
  // 窄的地方少画几根，竖条之间留出空隙，不挤成一团
  const bars = width > 0 ? binned(peaks, Math.max(MIN_BARS, Math.floor(width / BAR_PITCH))) : peaks
  const played = Math.round(progress * bars.length)
  const path = (from: number, to: number) =>
    bars
      .slice(from, to)
      .map((peak, index) => {
        const half = Math.max(MIN_LEVEL, Math.min(1, peak))
        return `M${String(from + index + 0.5)} ${String(1 - half)}V${String(1 + half)}`
      })
      .join('')
  return (
    <span className={cn('block h-6 w-full', className)} ref={ref}>
      <svg
        aria-hidden
        className="block size-full overflow-visible"
        preserveAspectRatio="none"
        viewBox={`0 0 ${String(bars.length)} 2`}
      >
        {/* 线宽不随拉伸变，窄的宽的都是细竖条 */}
        <path
          className="stroke-on-surface"
          d={path(0, played)}
          strokeWidth={BAR_WIDTH}
          vectorEffect="non-scaling-stroke"
        />
        <path
          className="stroke-outline-variant"
          d={path(played, bars.length)}
          strokeWidth={BAR_WIDTH}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  )
}

function SeekArea({
  seek,
  progress,
  className,
  children,
}: {
  seek: WaveformSeek
  progress: number
  className?: string | undefined
  children: ReactNode
}) {
  const pressedRef = useRef(false)
  const { durationMs, label, onSeek } = seek
  const seekAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width > 0) onSeek((event.clientX - box.left) / box.width)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const now = progress * durationMs
    const target =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? now - KEY_STEP_MS
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? now + KEY_STEP_MS
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? durationMs
              : null
    if (target === null || durationMs <= 0) return
    event.preventDefault()
    onSeek(target / durationMs)
  }
  const nowMs = Math.round(progress * durationMs)
  return (
    <div
      aria-label={label}
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuemin={0}
      aria-valuenow={Math.floor(nowMs / 1000)}
      aria-valuetext={`${audioClockText(nowMs)} / ${audioClockText(durationMs)}`}
      className={cn(
        'flex h-6 min-w-0 cursor-pointer touch-none items-center rounded-xs ui-focus',
        className,
      )}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        pressedRef.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        seekAt(event)
      }}
      onPointerMove={(event) => {
        if (pressedRef.current) seekAt(event)
      }}
      onPointerUp={() => {
        pressedRef.current = false
      }}
      onPointerCancel={() => {
        pressedRef.current = false
      }}
      role="slider"
      tabIndex={0}
    >
      {children}
    </div>
  )
}
