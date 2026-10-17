import { useDraggable } from '@dnd-kit/core'
import { useParams } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { memo, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { conversationStatusLabel, mediaStatusLabel } from '@/shared/ui/status-badge'
import { toast } from '@/shared/ui/toast'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { conversationStatus, needsAttention, type AttentionStatus } from '../conversation-status'
import {
  useRenameConversation,
  useSetConversationCompletion,
  type Conversation,
} from '../conversations.api'
import { useSeenRun } from '../conversations.unread'
import {
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_CLASS,
  SIDEBAR_ROW_MENU_OPEN,
  SIDEBAR_ROW_TITLE_CLASS,
  SIDEBAR_ROW_TRAILING_SHOWN,
} from './sidebar-row-classes'
import { SidebarRowEditor } from './sidebar-row-editor'
import { useSidebarRowEditing } from './use-sidebar-row-editing'

const UNREAD_LABEL = '有新回复'

const useUnread = (conversation: Conversation, active: boolean): boolean => {
  const seenRun = useSeenRun(conversation.id)
  return !active && seenRun !== undefined && seenRun !== conversation.lastRunId
}

type SidebarConversationRowProps = {
  conversation: Conversation
  dragging: boolean
  /** 请调用方打开删除确认；删除本身由确认弹窗执行。 */
  onDelete: (conversation: Conversation) => void
  onOpenMembership: (conversation: Conversation) => void
  /** 编辑或菜单打开期间保留虚拟行，避免滚动卸载交互状态。 */
  onInteractionChange: (active: boolean) => void
}

/** 侧栏一行对话：打开、改名、移到合集、标记完成与删除；改对话要有 agent:run，改完各 mutation 自己刷新列表。 */
export const SidebarConversationRow = memo(function SidebarConversationRow({
  conversation,
  dragging,
  onDelete,
  onOpenMembership,
  onInteractionChange,
}: SidebarConversationRowProps) {
  const canWrite = hasPermission(useUser().data, PERMISSION.agentRun)
  const { listeners, setNodeRef, transform } = useDraggable({
    disabled: !canWrite,
    data: { collectionId: conversation.collectionId },
    id: conversation.id,
  })
  const active = useParams({
    select: (params) => params.conversationId === conversation.id,
    strict: false,
  })
  const { close, editing, onMenuCloseAutoFocus, onMenuOpenChange, returnRef, start } =
    useSidebarRowEditing<HTMLAnchorElement>(onInteractionChange)
  const rename = useRenameConversation()
  const completion = useSetConversationCompletion()
  const [tipOpen, setTipOpen] = useState(false)
  const completed = conversation.completedAt !== null
  const unread = useUnread(conversation, active)
  const status = conversationStatus(conversation.activity)
  const showUnread = unread && status === 'completed'
  const video = conversation.activity.videoGeneration
  const videoLabel = video === 'none' ? undefined : `视频${mediaStatusLabel(video)}`
  const statusLabels = [
    ...(needsAttention(status) ? [conversationStatusLabel(status)] : []),
    ...(videoLabel === undefined ? [] : [videoLabel]),
    ...(showUnread ? [UNREAD_LABEL] : []),
    ...(completed ? ['已完成'] : []),
  ]

  if (editing)
    return (
      <SidebarRowEditor
        className={cn(active && 'font-semibold')}
        failureMessage="重命名失败"
        initialValue={conversation.title}
        label={`重命名 ${conversation.title}`}
        onClose={close}
        onSubmit={(title) => rename.mutateAsync({ conversationId: conversation.id, title })}
      />
    )

  return (
    <TooltipRoot onOpenChange={setTipOpen} open={tipOpen && statusLabels.length > 0 && !dragging}>
      <TooltipTrigger asChild>
        {/* 拖拽绑在整行而不是链接上：链接的原生拖动会吞掉指针事件。 */}
        <div
          className={cn(
            SIDEBAR_ROW_CLASS,
            dragging && 'layer-local-2 opacity-50',
            active ? SIDEBAR_ROW_ACTIVE : SIDEBAR_ROW_MENU_OPEN,
          )}
          ref={setNodeRef}
          style={
            transform
              ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
              : undefined
          }
          {...(canWrite ? listeners : {})}
        >
          <Link
            ref={returnRef}
            aria-current={active ? 'page' : undefined}
            className={SIDEBAR_ROW_TITLE_CLASS}
            draggable={false}
            params={{ conversationId: conversation.id }}
            to="/c/$conversationId"
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-left',
                completed && !active && 'text-on-surface-faint',
              )}
            >
              {conversation.title}
            </span>
          </Link>
          <span className="flex shrink-0 items-center gap-1.5 empty:hidden">
            {needsAttention(status) && <ConversationGlyph status={status} />}
            {videoLabel !== undefined && (
              <span
                aria-label={videoLabel}
                className={cn(
                  'size-3.5 shrink-0 rounded-full border-2',
                  video === 'running'
                    ? 'border-primary/20 border-t-primary motion-safe:animate-spin'
                    : 'border-primary/40',
                )}
                role="img"
              />
            )}
            {showUnread && (
              <span
                aria-label={UNREAD_LABEL}
                className="size-2 shrink-0 rounded-full bg-on-surface"
                role="img"
              />
            )}
            {completed && (
              <Icon
                className="shrink-0 text-on-surface-faint"
                label="已完成"
                name="check"
                size="sm"
              />
            )}
          </span>
          {canWrite && (
            <div className={cn(SIDEBAR_ROW_TRAILING_SHOWN, 'shrink-0 items-center')}>
              <MenuRoot onOpenChange={onMenuOpenChange}>
                <MenuTrigger asChild>
                  <IconButton label={`${conversation.title} 的更多操作`} name="more" size="xs" />
                </MenuTrigger>
                <MenuSurface align="end" onCloseAutoFocus={onMenuCloseAutoFocus}>
                  <MenuItem icon="edit" onSelect={start}>
                    重命名
                  </MenuItem>
                  <MenuItem icon="folder" onSelect={() => onOpenMembership(conversation)}>
                    移到合集…
                  </MenuItem>
                  <MenuItem
                    icon="check"
                    onSelect={() =>
                      completion.mutate(
                        { completed: !completed, conversationId: conversation.id },
                        { onError: (error) => toast.error(errorMessageOf(error, '标记完成失败')) },
                      )
                    }
                  >
                    {completed ? '取消完成' : '标记完成'}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem destructive icon="delete" onSelect={() => onDelete(conversation)}>
                    删除
                  </MenuItem>
                </MenuSurface>
              </MenuRoot>
            </div>
          )}
        </div>
      </TooltipTrigger>
      {statusLabels.length > 0 && (
        <TooltipContent side="right">{statusLabels.join(' · ')}</TooltipContent>
      )}
    </TooltipRoot>
  )
})

function ConversationGlyph({ status }: { status: AttentionStatus }) {
  if (status === 'running')
    return (
      <Icon
        className="shrink-0 text-on-surface-variant motion-safe:animate-spin"
        label={conversationStatusLabel('running')}
        name="spinner"
        size="sm"
      />
    )
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-label whitespace-nowrap text-on-surface-variant">
      {status === 'failed' ? (
        <Icon className="shrink-0 text-error" decorative name="alert" size="sm" />
      ) : (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-warning ring-3 ring-warning/20"
        />
      )}
      {conversationStatusLabel(status)}
    </span>
  )
}
