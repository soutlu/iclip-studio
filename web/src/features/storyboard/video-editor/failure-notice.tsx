import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import type { FailureNotice as Notice } from './failure-notices'

type FailureNoticeProps = {
  notices: readonly Notice[]
  onOpen: (notice: Notice) => void
  onDismiss: (notice: Notice) => void
}

export function FailureNotice({ notices, onOpen, onDismiss }: FailureNoticeProps) {
  const [latest] = notices
  if (latest === undefined) return null
  return (
    <div className="video-editor-fail">
      <button
        className="video-editor-fail-text text-error ui-focus"
        onClick={() => onOpen(latest)}
        title={latest.text}
        type="button"
      >
        <Icon decorative name="alert" size="sm" />
        <span>{latest.text}</span>
      </button>
      {notices.length > 1 ? (
        <span className="video-editor-fail-more text-on-surface-muted">
          另有 {notices.length - 1} 条
        </span>
      ) : null}
      <IconButton label="关闭提醒" name="close" onClick={() => onDismiss(latest)} size="xs" />
    </div>
  )
}
