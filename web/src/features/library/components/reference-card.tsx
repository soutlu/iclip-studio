import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PLACEHOLDER_VIDEO_RATIO } from '../library-layout'
import type { TagIndex } from '../library-tags'
import { referenceTitleOf, UNTAGGED_YET } from '../reference-labels'
import type { PendingUpload } from '../reference-upload'
import { isTaggingBusy, type ReferenceItem } from '../references.api'
import { AuthorAvatar } from './author-avatar'
import { CardByline } from './card-byline'
import { PlaceholderRatioCard } from './placeholder-ratio-card'

type ReferenceCardProps = {
  item: ReferenceItem
  tags: TagIndex
  width: number
  onOpen: (id: string) => void
  onAuthor: (userName: string) => void
}

export function ReferenceCard({ item, tags, width, onOpen, onAuthor }: ReferenceCardProps) {
  const title = referenceTitleOf(item, tags)
  return (
    <PlaceholderRatioCard
      badges={<StatusBadge item={item} />}
      cardId={item.id}
      label={title.text}
      onOpen={() => onOpen(item.id)}
      openLabel={`查看详情：${title.text}`}
      videoUrl={item.videoUrl}
      width={width}
    >
      <h3
        className={cn(
          'line-clamp-2 text-body break-words',
          title.placeholder ? 'text-on-surface-faint' : 'font-medium text-on-surface',
        )}
      >
        {title.text}
      </h3>
      <CardByline
        at={item.createdAt}
        author={item.userName}
        itemNoun="参考视频"
        onAuthor={onAuthor}
      />
    </PlaceholderRatioCard>
  )
}

/** 左上角的后台状态：拆解没结束或没拆成时说拆解；拆完了再说打标（排队与打标中合成一种）。 */
function StatusBadge({ item }: { item: Pick<ReferenceItem, 'breakdownStatus' | 'tagStatus'> }) {
  const { breakdownStatus: status, tagStatus } = item
  if (status !== 'completed')
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
  if (!isTaggingBusy(tagStatus) && tagStatus !== 'failed') return null
  return (
    <span className="library-card-badge pointer-events-none absolute top-2 left-2">
      {tagStatus === 'failed' ? (
        <Icon decorative name="alert" size="xs" />
      ) : (
        <Icon className="animate-spin" decorative name="spinner" size="xs" />
      )}
      {tagStatus === 'failed' ? '打标失败' : '正在打标'}
    </span>
  )
}

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
        style={{ aspectRatio: PLACEHOLDER_VIDEO_RATIO }}
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
