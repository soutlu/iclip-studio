import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { aspectOf } from '@/shared/lib/aspect-ratio'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'
import { Tag } from '@/shared/ui/tag'
import type { LibraryVideo } from '../library.api'
import { snapshotWidthFor } from '../library-layout'
import { cardTitleOf, durationSecondsOf, openingTextOf } from '../library-media'
import { CardByline } from './card-byline'
import { cardOpenerProps } from './card-focus'
import { StoryboardBadge } from './library-storyboard'

const PREVIEW_DELAY_MS = 300

const canAutoPreview = (): boolean => {
  const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
  return (
    saveData !== true &&
    window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches
  )
}

const usePreviewIntent = () => {
  const [active, setActive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])
  return {
    active,
    onPointerEnter: () => {
      if (!canAutoPreview()) return
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setActive(true), PREVIEW_DELAY_MS)
    },
    onPointerLeave: () => {
      clearTimeout(timerRef.current)
      setActive(false)
    },
  }
}

/** 卡上用得到的：成片素材的一张卡，或爆款素材的一版。`id` 是打开它、找回焦点用的 id；
 * 组数与版数只有成片素材的卡有。 */
export type CardVideo = Pick<LibraryVideo, 'id' | 'title' | 'userName' | 'face' | 'take'> &
  Partial<Pick<LibraryVideo, 'groupCount' | 'versionCount'>>

type LibraryCardProps = {
  video: CardVideo
  width: number
  /** 点作者按人筛选；不给就不能点。 */
  onAuthor?: (userName: string) => void
  onOpen: (id: string, startAt: number | null) => void
  /** 画面左下角另加的状态，悬停露出正文时隐去。 */
  status?: ReactNode
}

export function LibraryCard({ video, width, onAuthor, onOpen, status }: LibraryCardProps) {
  const { face, take } = video
  const aspect = aspectOf(take.aspectRatio)
  const poster =
    width > 0
      ? videoSnapshotUrl(face.outputUrl, snapshotWidthFor(width, window.devicePixelRatio || 1))
      : null
  const preview = usePreviewIntent()
  const [storyboardAt, setStoryboardAt] = useState<number | null>(null)
  const showPreview = preview.active || (storyboardAt !== null && canAutoPreview())
  const { copied, copy } = useCopyFeedback()
  const [posterLoaded, setPosterLoaded] = useState(false)
  const compact = width > 0 && width < 220
  const seconds = durationSecondsOf(face.durationMs, take)
  const title = cardTitleOf(video)

  return (
    <article aria-label={title} className="library-card group flex flex-col">
      <div
        className="library-card-media relative overflow-hidden rounded-md bg-surface-container-low"
        onPointerEnter={preview.onPointerEnter}
        onPointerLeave={preview.onPointerLeave}
        style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}
      >
        {poster === null ? null : poster === undefined ? (
          // 不是 OSS 地址无法截帧。
          <span className="absolute inset-0 grid place-items-center text-on-surface-variant">
            <Icon decorative name="video" size="xl" />
          </span>
        ) : (
          <img
            alt=""
            className={cn(
              'library-card-poster absolute inset-0 size-full object-contain',
              posterLoaded && 'library-card-poster-loaded',
            )}
            decoding="async"
            loading="lazy"
            onLoad={() => setPosterLoaded(true)}
            src={poster}
          />
        )}
        {showPreview ? <PreviewVideo seekTo={storyboardAt} src={face.outputUrl} /> : null}
        <button
          aria-label={`查看详情：${title}`}
          className="absolute inset-0 cursor-pointer rounded-md ui-focus"
          {...cardOpenerProps(video.id)}
          onClick={() => onOpen(video.id, null)}
          type="button"
        />

        <div className="pointer-events-none absolute top-2 left-2 flex gap-1.5">
          {face.kind === 'composite' ? <Tag variant="success">合成</Tag> : null}
          {(video.groupCount ?? 0) > 1 ? (
            <span className="library-card-badge">{video.groupCount} 组</span>
          ) : null}
          {(video.versionCount ?? 0) > 1 ? (
            <span className="library-card-badge">{video.versionCount} 版</span>
          ) : null}
        </div>
        {/* 放左下角：窄列上顶部一行已被角标与故事板占满。 */}
        {status === undefined ? null : (
          <div className="library-card-hide-on-hover pointer-events-none absolute bottom-2 left-2">
            {status}
          </div>
        )}
        <StoryboardBadge
          compact={compact}
          onFocusFrame={setStoryboardAt}
          onPickFrame={(at) => onOpen(video.id, at)}
          seconds={seconds}
          video={video}
        />
        {/* 有状态时让出底边，免得两个角标挤在一起。 */}
        {take.model === null || compact || status !== undefined ? null : (
          <span className="library-card-badge library-card-hide-on-hover pointer-events-none absolute right-2 bottom-2">
            {take.model}
          </span>
        )}

        <div className="library-card-hover pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 px-2.5 pt-10 pb-2.5 text-on-scrim">
          <p className="line-clamp-3 text-body-sm">{openingTextOf(take)}</p>
          <div className="flex justify-end">
            <IconButton
              className="library-card-hover-button pointer-events-auto"
              label={copied ? '已复制完整提示词' : '复制完整提示词'}
              name={copied ? 'check' : 'copy'}
              onClick={() => void copy(take.prompt)}
              size="sm"
            />
          </div>
        </div>
      </div>

      <div className="px-0.5 pt-2.5">
        <h3 className="line-clamp-2 text-body font-medium text-on-surface">{title}</h3>
        <CardByline
          at={face.finishedAt}
          author={video.userName}
          itemNoun="视频"
          onAuthor={onAuthor}
        />
      </div>
    </article>
  )
}

/** 卸载时清掉地址：浏览器随之中止下载、释放解码器。 */
function PreviewVideo({ src, seekTo }: { src: string; seekTo: number | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [shown, setShown] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const element = ref.current
    return () => {
      if (element === null) return
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [])

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    if (seekTo !== null) {
      element.pause()
      element.currentTime = seekTo
    } else if (element.paused && element.currentTime > 0) {
      void element.play().catch(() => undefined)
    }
  }, [seekTo])

  return (
    <>
      <video
        aria-hidden="true"
        autoPlay
        className={cn(
          'library-card-preview absolute inset-0 size-full object-contain',
          shown && 'library-card-preview-playing',
        )}
        loop
        muted
        onPlaying={() => setShown(true)}
        // 直接跳到某一帧时不触发 playing，只有 seeked。
        onSeeked={() => setShown(true)}
        onTimeUpdate={(event) => {
          const { currentTime, duration } = event.currentTarget
          if (duration > 0) setProgress(currentTime / duration)
        }}
        playsInline
        preload="auto"
        ref={ref}
        src={src}
        tabIndex={-1}
      />
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 bg-on-scrim"
        style={{ width: `${progress * 100}%` }}
      />
    </>
  )
}
