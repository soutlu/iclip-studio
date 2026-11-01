/** 标题来自 transcript 基线与推送；侧栏拓扑仅包含各列表首页，无法覆盖全部历史对话，页头合集标签因此只在拓扑里找得到时显示。 */

import type { ReactNode } from 'react'
import { useUser, useUsersDirectory } from '@/shared/auth'
import { useConversationReadOnly } from '@/shared/transcript/use-conversation-read-only'
import { useConversationTitle } from '@/shared/transcript/use-conversation-title'
import { useTranscript } from '@/shared/transcript/use-transcript'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useShellChrome } from '@/shared/shell'
import { IconButton } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'
import { useCachedConversationCollection } from '../conversations.api'
import { ConversationTimeline } from './conversation-timeline'

type ConversationRouteProps = {
  conversationId: string
  /** 只读说明条右侧的返回入口；去哪由路由层决定，只在只读时露出。 */
  backLink?: ReactNode
  /** 分叉成功后去副本；导航归路由层，不给回调就没有分叉入口。 */
  onForked?: (conversationId: string) => void
  /** 血缘提示里回源对话的链接，由路由层按源 id 造。 */
  sourceLink?: (conversationId: string) => ReactNode
}

export function ConversationRoute({
  conversationId,
  backLink,
  onForked,
  sourceLink,
}: ConversationRouteProps) {
  const { view } = useTranscript(conversationId)
  const title = useConversationTitle(conversationId, view.title)
  // 页头的合集标签只用侧栏已经拿到的拓扑，不为它单发请求；拓扑里找不到就不显示。
  const collection = useCachedConversationCollection(conversationId)
  // 只读只发生在治理者复盘别人的或已删的对话时，名册接口也只有治理者能读。
  const readOnly = useConversationReadOnly(view)
  const { data: user } = useUser()
  const { nameOf } = useUsersDirectory(readOnly)
  const ownerName = view.ownerUserId === null ? undefined : nameOf(view.ownerUserId)
  const deleted = view.deletedAt !== null
  const readOnlyLabel = deleted ? '已删除' : '只读'
  // 治理者看自己删掉的对话也是只读；主语是自己就不写成第三人称。
  const ownMine = view.ownerUserId !== null && view.ownerUserId === user?.id
  const ownerPhrase = ownMine
    ? '自己的任务'
    : ownerName === undefined
      ? undefined
      : `${ownerName} 的任务`
  const noteOwner = ownMine ? '当前账号' : ownerName === undefined ? '其他账号' : ` ${ownerName}`
  const readOnlyNote = `该任务属于${noteOwner}${deleted ? '，已删除' : ''}，仅可查看`
  const chrome = useShellChrome()

  return (
    // 高度钉在所在栏，使滚动限制在消息区，保持输入框和自动跟随定位稳定。
    <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header
        className={cn(
          'group/pane-header flex h-13 shrink-0 items-center gap-3 border-b-[0.5px] border-chat-hairline pr-2 pl-4',
          chrome.sidebarOverlay && 'pr-14 pl-14',
        )}
        data-pane-drag-handle
      >
        <h1 className="min-w-0 truncate text-body font-semibold text-on-surface">{title}</h1>
        {collection === undefined ? null : (
          <Tag className="max-w-40 shrink-0" title={`所属合集：${collection.name}`} variant="soft">
            <Icon decorative name="folder" size="xs" />
            <span className="truncate">{collection.name}</span>
          </Tag>
        )}
        {readOnly ? (
          <Tag className="shrink-0" variant="soft">
            <Icon decorative name="preview" size="xs" />
            {ownerPhrase === undefined ? readOnlyLabel : `${readOnlyLabel} · ${ownerPhrase}`}
          </Tag>
        ) : null}
        {chrome.chat === undefined ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 group-focus-within/pane-header:opacity-100 group-hover/pane-header:opacity-100 touch:opacity-100">
            {chrome.onSwapPanes === undefined ? null : (
              <IconButton
                label="交换对话与工作台"
                name="swap-panes"
                onClick={chrome.onSwapPanes}
                size="sm"
              />
            )}
            <IconButton
              label="折叠对话"
              name="panel-left"
              onClick={chrome.chat.onCollapse}
              size="sm"
            />
          </div>
        )}
      </header>
      <ConversationTimeline
        conversationId={conversationId}
        onForked={onForked}
        readOnly={readOnly ? { backLink, note: readOnlyNote } : undefined}
        sourceLink={sourceLink}
      />
    </main>
  )
}
