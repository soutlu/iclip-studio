import { formatRelativeTime } from '@/shared/lib/relative-time'
import { AuthorAvatar } from './author-avatar'

type Props = {
  author: string | null
  itemNoun: string
  /** 点作者按人筛选；不给就只显示作者，不能点。 */
  onAuthor?: ((userName: string) => void) | undefined
  at: string
}

export function CardByline({ author, itemNoun, onAuthor, at }: Props) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-body-sm text-on-surface-variant">
      {author === null ? null : onAuthor === undefined ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 py-0.5 pr-1.5">
          <AuthorAvatar className="size-4.5 text-caption" name={author} />
          <span className="truncate">{author}</span>
        </span>
      ) : (
        <button
          className="inline-flex min-w-0 ui-state items-center gap-1.5 rounded-full py-0.5 pr-1.5 ui-focus"
          onClick={() => onAuthor(author)}
          title={`仅显示 ${author} 的${itemNoun}`}
          type="button"
        >
          <AuthorAvatar className="size-4.5 text-caption" name={author} />
          <span className="truncate">{author}</span>
        </button>
      )}
      <span className="shrink-0 text-on-surface-faint">{formatRelativeTime(at)}</span>
    </div>
  )
}
