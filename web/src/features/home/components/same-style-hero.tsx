import { aspectOf } from '@/shared/lib/aspect-ratio'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'

export type SameStyleVideo = {
  title: string | null
  outputUrl: string
  aspectRatio: string | null
}

const SNAPSHOT_WIDTH = 600

const frameRatioOf = (aspectRatio: string | null): string => {
  const { w, h } = aspectOf(aspectRatio)
  return w > h ? '4 / 3' : w < h ? '3 / 4' : '1 / 1'
}

type SameStyleHeroProps = {
  video: SameStyleVideo | null
  onExit: () => void
}

export function SameStyleHero({ video, onExit }: SameStyleHeroProps) {
  const poster = video === null ? undefined : videoSnapshotUrl(video.outputUrl, SNAPSHOT_WIDTH)
  return (
    <div
      className="relative h-56 animate-in duration-(--dur-l) ease-(--ease-decel) zoom-in-95 fade-in motion-reduce:animate-none max-sm:h-44"
      style={{ aspectRatio: frameRatioOf(video?.aspectRatio ?? null) }}
    >
      <span
        aria-hidden
        className="absolute inset-0 -translate-x-3.5 translate-y-1 -rotate-7 rounded-lg border-[0.5px] border-hairline bg-surface-container-highest"
      />
      <span
        aria-hidden
        className="absolute inset-0 translate-x-3.5 translate-y-0.5 rotate-6 rounded-lg border-[0.5px] border-hairline bg-surface-container-highest opacity-70"
      />
      <div
        className={cn(
          'absolute inset-0 overflow-hidden rounded-lg bg-surface-container-high shadow-[var(--shadow-3)]',
          video === null && 'motion-safe:animate-pulse',
        )}
      >
        {video === null ? null : (
          <>
            {poster === undefined ? (
              <video
                aria-hidden
                className="size-full object-cover"
                muted
                playsInline
                preload="metadata"
                // 附加 #t=0.001 使 Safari 渲染视频首帧。
                src={video.outputUrl.includes('#') ? video.outputUrl : `${video.outputUrl}#t=0.1`}
                tabIndex={-1}
              />
            ) : (
              <img alt="" className="size-full object-cover" decoding="async" src={poster} />
            )}
            {video.title === null ? null : (
              <div className="absolute inset-x-0 bottom-0 flex h-3/5 items-end bg-[image:var(--media-scrim-photo-strong)] px-3 pb-2.5">
                <p className="line-clamp-2 text-body font-semibold text-on-scrim">{video.title}</p>
              </div>
            )}
          </>
        )}
      </div>
      <IconButton
        className="hit-48 absolute -top-2.5 -right-2.5 rounded-full border-[0.5px] border-hairline bg-surface-container-lowest shadow-[var(--shadow-1)]"
        label="不做同款"
        name="close"
        onClick={onExit}
        size="xs"
      />
    </div>
  )
}
