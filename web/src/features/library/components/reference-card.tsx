/** 参考视频的一张卡：封面是视频首帧截图，左上角是拆解状态，下面是标签行与属主、时间。点画面进详情。
 *
 * 正在上传的文件还没建行，另画一张只有进度的卡，排在最前面。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { REFERENCE_FALLBACK_RATIO, snapshotWidthFor } from '../library-layout'
import { referenceTitleOf, UNTAGGED_YET, type VideoTypeLabels } from '../reference-labels'
import type { PendingUpload } from '../reference-upload'
import type { ReferenceItem } from '../references.api'
import { AuthorAvatar } from './author-avatar'

type ReferenceCardProps = {
  item: ReferenceItem
  labels: VideoTypeLabels
  /** 这一列的显示宽度，决定封面截多大。 */
  width: number
  onOpen: (id: string) => void
  onAuthor: (userName: string) => void
}

export function ReferenceCard({ item, labels, width, onOpen, onAuthor }: ReferenceCardProps) {
  // 列宽量出来之前不请求封面，免得先按占位宽度截一张、量完再截一张。
  const poster =
    width > 0
      ? videoSnapshotUrl(item.videoUrl, snapshotWidthFor(width, window.devicePixelRatio || 1))
      : null
  // 列表项不带画幅：先按竖版占位，封面到了按它的实际比例撑开。
  const [ratio, setRatio] = useState(REFERENCE_FALLBACK_RATIO)
  const [posterLoaded, setPosterLoaded] = useState(false)
  const title = referenceTitleOf(item, labels)
  const author = item.userName

  return (
    <article aria-label={title.text} className="library-card group flex flex-col">
      <div
        className="library-card-media relative overflow-hidden rounded-md bg-surface-container-low"
        style={{ aspectRatio: ratio }}
      >
        {poster === null ? null : poster === undefined ? (
          // 不是 OSS 地址截不了帧，只放一个视频图标。
          <span className="absolute inset-0 grid place-items-center text-on-surface-variant">
            <Icon decorative name="video" size="xl" />
          </span>
        ) : (
          <img
            alt=""
            className={cn(
              'library-card-poster absolute inset-0 size-full object-cover',
              posterLoaded && 'library-card-poster-loaded',
            )}
            decoding="async"
            loading="lazy"
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) setRatio(naturalWidth / naturalHeight)
              setPosterLoaded(true)
            }}
            src={poster}
          />
        )}
        <button
          aria-label={`查看详情：${title.text}`}
          className="absolute inset-0 cursor-pointer rounded-md ui-focus"
          data-open-reference={item.id}
          onClick={() => onOpen(item.id)}
          type="button"
        />
        <StatusBadge status={item.breakdownStatus} />
      </div>

      <div className="px-0.5 pt-2.5">
        <h3
          className={cn(
            'line-clamp-2 text-body break-words',
            title.placeholder ? 'text-on-surface-faint' : 'font-medium text-on-surface',
          )}
        >
          {title.text}
        </h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-body-sm text-on-surface-variant">
          {author === null ? null : (
            <button
              className="inline-flex min-w-0 ui-state items-center gap-1.5 rounded-full py-0.5 pr-1.5 ui-focus"
              onClick={() => onAuthor(author)}
              title={`只看 ${author} 的参考视频`}
              type="button"
            >
              <AuthorAvatar className="size-4.5 text-caption" name={author} />
              <span className="truncate">{author}</span>
            </button>
          )}
          <span className="shrink-0 text-on-surface-faint">
            {formatRelativeTime(item.createdAt)}
          </span>
        </div>
      </div>
    </article>
  )
}

function StatusBadge({ status }: { status: ReferenceItem['breakdownStatus'] }) {
  if (status === 'completed') return null
  return (
    <span className="library-card-badge pointer-events-none absolute top-2 left-2">
      {status === 'running' ? (
        <Icon className="animate-spin" decorative name="spinner" size="xs" />
      ) : status === 'failed' ? (
        <Icon decorative name="alert" size="xs" />
      ) : null}
      {status === 'pending' ? '排队中' : status === 'running' ? '拆解中' : '拆解失败'}
    </span>
  )
}

/** 正在上传的那张卡：没有封面，压一条进度；文件名放在画面里，太长截断。 */
export function UploadingCard({
  upload,
  myUserName,
}: {
  upload: PendingUpload
  myUserName: string | null
}) {
  const percent = Math.round(upload.progress * 100)
  return (
    <article aria-label={`正在上传：${upload.name}`} className="library-card flex flex-col">
      <div
        className="library-card-media relative overflow-hidden rounded-md bg-surface-container-low"
        style={{ aspectRatio: REFERENCE_FALLBACK_RATIO }}
      >
        <span className="absolute inset-0 grid place-items-center text-on-surface-faint">
          <Icon decorative name="video" size="xl" />
        </span>
        <span className="library-card-badge pointer-events-none absolute top-2 left-2">
          上传中 {percent}%
        </span>
        <p className="absolute inset-x-3 bottom-4 truncate text-center text-caption text-on-surface-variant">
          {upload.name}
        </p>
        <div
          aria-label={`${upload.name} 上传进度`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="absolute inset-x-0 bottom-0 h-1 bg-surface-container-high"
          role="progressbar"
        >
          <div className="h-full bg-on-surface ui-motion-s" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="px-0.5 pt-2.5">
        <h3 className="line-clamp-2 text-body text-on-surface-faint">{UNTAGGED_YET}</h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-body-sm text-on-surface-variant">
          {myUserName === null ? null : (
            <span className="inline-flex min-w-0 items-center gap-1.5 py-0.5 pr-1.5">
              <AuthorAvatar className="size-4.5 text-caption" name={myUserName} />
              <span className="truncate">{myUserName}</span>
            </span>
          )}
          <span className="shrink-0 text-on-surface-faint">刚刚</span>
        </div>
      </div>
    </article>
  )
}
