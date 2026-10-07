import { aspectOf } from '@/shared/lib/aspect-ratio'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'

/** 做同款的那条视频：卡片标题（来源对话没有标题时为 null，不压字）、卡面成片的地址与画幅。 */
export type SameStyleVideo = {
  title: string | null
  outputUrl: string
  aspectRatio: string | null
}

/** 封面截帧的宽度：卡片最宽约 300 CSS 像素，按 2 倍屏取。 */
const SNAPSHOT_WIDTH = 600

/** 封面框只分竖、横、方三种，卡片高度固定，宽度随画幅；画面按框裁切。 */
const frameRatioOf = (aspectRatio: string | null): string => {
  const { w, h } = aspectOf(aspectRatio)
  return w > h ? '4 / 3' : w < h ? '3 / 4' : '1 / 1'
}

type SameStyleHeroProps = {
  /** 源视频；读回来之前为 null，先摆出卡片的占位。 */
  video: SameStyleVideo | null
  /** 右上角 ✕：退出做同款，回到普通首页。 */
  onExit: () => void
}

/**
 * 做同款时首页顶部换成这条视频的封面：标题压在封面底部的深色渐变上，后面斜叠两张卡片，像从资料库里抽出来的那一张。
 * 不另加说明文字。封面是 OSS 截帧；不是 OSS 地址截不了帧，就用不出声、不预加载全片的视频元素显示首帧。
 */
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
                // 媒体片段让 Safari 也画出首帧；地址自带片段时照原样。
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
