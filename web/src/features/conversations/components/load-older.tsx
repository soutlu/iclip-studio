import { Icon } from '@/shared/icons'

type LoadOlderProps = {
  hasMoreOlder: boolean
  loadingOlder: boolean
  loadOlderError: boolean
  onLoad: () => void
}

export function LoadOlder({ hasMoreOlder, loadOlderError, loadingOlder, onLoad }: LoadOlderProps) {
  if (!hasMoreOlder) return null
  return (
    <div className="flex justify-center">
      <button
        className="flex ui-state cursor-pointer items-center gap-1 rounded-full border-[0.5px] border-chat-hairline px-3 py-1.5 text-body-sm text-chat-secondary-text ui-focus disabled:cursor-default"
        disabled={loadingOlder}
        onClick={onLoad}
        type="button"
      >
        {loadingOlder ? (
          <Icon className="animate-spin" decorative name="loading" size="sm" />
        ) : (
          <Icon decorative name="collapse" size="sm" />
        )}
        {loadingOlder
          ? '正在加载更早的消息'
          : loadOlderError
            ? '加载失败，请点击重试'
            : '加载更早的消息'}
      </button>
    </div>
  )
}
