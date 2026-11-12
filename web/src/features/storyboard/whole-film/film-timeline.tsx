import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { useAudioPeaks } from '../editing/media-analysis'
import { Frames, TimelinePlayhead, TimelineRuler, Wave } from '../editing/timeline'
import { useStableValue } from '../editing/use-stable-value'
import type { PictureBlock } from './composition/film'
import { rowsOf, type Landing } from './placement'
import { msToPx, pxToMs, type TimelineScale } from './timeline-scale'

export type TimelinePoint = { track: number; timeMs: number }

export type TimelineHandle = {
  /** 屏幕上的这个点在哪一行、对应成片的第几毫秒；不在任何一行上时是 null。 */
  locate: (clientX: number, clientY: number) => TimelinePoint | null
}

/** 拖着的素材会落在哪里：`duration` 是它的总长（毫秒）。 */
export type DropGhost = Landing & { duration: number }

type FilmTimelineProps = {
  pictures: readonly PictureBlock[]
  totalMs: number
  playheadMs: number
  buffered: readonly TimeSpan[]
  scale: TimelineScale
  ghost: DropGhost | null
  onSeek: (ms: number) => void
  onViewportWidth: (width: number) => void
  handleRef: RefObject<TimelineHandle | null>
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

// 指针离一行的上下边这么近也算在这一行上
const ROW_REACH_PX = 3

// 时间区左右留的空（whole-film.css 里 .wf-track-content 的 margin：左 8、右 16），不算进能排时间的宽度
const INSET_PX = 24

/** 时间线：成片里的块按行排开，上面是时间尺和播放头。 */
export function FilmTimeline({
  pictures,
  totalMs,
  playheadMs,
  buffered,
  scale,
  ghost,
  onSeek,
  onViewportWidth,
  handleRef,
}: FilmTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { pps, contentWidth } = scale
  const rows = rowsOf(pictures)
  // 还没有块时也留一行，素材拖得进来
  const shown = rows.length === 0 ? [{ track: 0, blocks: [] }] : rows
  const peaks = useAudioPeaks(useStableValue([...new Set(pictures.map((block) => block.src))]))

  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (viewport === null) return
    const report = () => onViewportWidth(Math.max(0, viewport.clientWidth - INSET_PX))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [onViewportWidth])

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  useEffect(() => {
    handleRef.current = {
      locate: (clientX, clientY) => {
        const viewport = scrollRef.current?.getBoundingClientRect()
        if (viewport === undefined || clientX < viewport.left || clientX > viewport.right)
          return null
        const lane = [
          ...(contentRef.current?.querySelectorAll<HTMLElement>('[data-track]') ?? []),
        ].find((element) => {
          const { top, bottom } = element.getBoundingClientRect()
          return clientY >= top - ROW_REACH_PX && clientY <= bottom + ROW_REACH_PX
        })
        if (lane === undefined) return null
        return { track: Number(lane.dataset['track']), timeMs: Math.max(0, timeAt(clientX)) }
      },
    }
    return () => {
      handleRef.current = null
    }
  })

  return (
    <div className="wf-tracks">
      <div className="wf-track-heads">
        {shown.map(({ track, blocks }) => (
          <span className="wf-track-head" key={track}>
            <span className="wf-head-name">{blocks[0]?.label}</span>
            {blocks.length > 1 ? (
              <span aria-label={`${blocks.length} 个块`} className="wf-head-count">
                {blocks.length}
              </span>
            ) : null}
          </span>
        ))}
      </div>
      <div className="wf-track-scroll" ref={scrollRef}>
        <div className="wf-track-content" ref={contentRef} style={{ width: contentWidth }}>
          <TimelineRuler
            buffered={buffered}
            clockAt={(clientX) => timeAt(clientX) / 1000}
            currentTime={playheadMs / 1000}
            disabled={totalMs <= 0}
            onScrub={() => {}}
            onSeek={(clock) => onSeek(Math.round(clock * 1000))}
            scale={contentWidth / pps}
            total={totalMs / 1000}
            viewportRef={scrollRef}
          />
          <div className="wf-lanes">
            {shown.map(({ track, blocks }, at) => (
              <div
                aria-label={`第 ${at + 1} 行`}
                className="wf-lane"
                data-track={track}
                key={track}
                role="group"
              >
                {blocks.map((block) => {
                  const part = {
                    mediaUrl: block.src,
                    start: block.mediaStart / 1000,
                    end: (block.mediaStart + block.duration) / 1000,
                  }
                  return (
                    <div
                      aria-label={`${block.label}，${seconds(block.duration)} 秒`}
                      className="wf-clip"
                      data-block-id={block.id}
                      key={block.id}
                      role="group"
                      style={{
                        left: msToPx(block.start, pps),
                        width: Math.max(2, msToPx(block.duration, pps) - 2),
                      }}
                    >
                      <span className="wf-clip-label">{block.label}</span>
                      <span className="wf-clip-media">
                        <span className="wf-clip-frames">
                          <Frames part={part} />
                        </span>
                        <span className="wf-clip-wave">
                          <Wave part={part} state={peaks.get(block.src) ?? { kind: 'loading' }} />
                        </span>
                      </span>
                    </div>
                  )
                })}
                {ghost?.track === track ? (
                  <span
                    aria-hidden="true"
                    className="wf-drop-ghost"
                    data-testid="drop-ghost"
                    style={{
                      left: msToPx(ghost.start, pps),
                      width: Math.max(2, msToPx(ghost.duration, pps) - 2),
                    }}
                  />
                ) : null}
                {pictures.length === 0 && ghost === null ? (
                  <span className="wf-lane-hint">把下面的镜头拖到这里</span>
                ) : null}
              </div>
            ))}
          </div>
          <TimelinePlayhead style={{ left: msToPx(Math.min(playheadMs, totalMs), pps) }} />
        </div>
      </div>
    </div>
  )
}
