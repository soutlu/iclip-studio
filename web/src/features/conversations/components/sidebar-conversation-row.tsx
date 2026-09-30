import { useDraggable } from '@dnd-kit/core'
import { useParams } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { conversationStatusLabel, mediaStatusLabel } from '@/shared/ui/status-badge'
import { toast } from '@/shared/ui/toast'
import { conversationStatus, needsAttention, type ConversationStatus } from '../conversation-status'
import {
  useRenameConversation,
  useSetConversationCompletion,
  type Conversation,
} from '../conversations.api'
import { useSeenRun } from '../conversations.unread'

// 侧栏各行共用：36px 行高，容器内左右 10px，图标与文字左缘落在同一条线上。
// 状态层作用于整行及尾部按钮；内部标题按钮只负责焦点环。
export const SIDEBAR_ROW_CLASS =
  'group flex h-9 ui-state cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-body text-on-surface'

export const SIDEBAR_ROW_TITLE_CLASS =
  'flex min-w-0 flex-1 items-center gap-2.5 rounded-xs ui-focus'

/** 选中行：浅灰侧栏上浮起的一枚胶囊；深色下 top-layer 是抬高一档的中性灰，不是纯白。 */
export const SIDEBAR_ROW_ACTIVE = 'bg-top-layer font-semibold shadow-[var(--shadow-1)]'

/** 行内 ⋯ 菜单打开时保持悬停底色；选中行保留自己的底色，不加这一层。 */
export const SIDEBAR_ROW_MENU_OPEN = 'has-data-[state=open]:bg-state-hover'

// 行尾信息与 ⋯ 共用尾部槽位：悬停或菜单展开时 ⋯ 顶替信息。
// 键盘聚焦只把 ⋯ 加进来、不收掉信息，读屏与看屏的键盘用户都还拿得到行尾状态。
export const SIDEBAR_ROW_TRAILING_HIDDEN = 'group-hover:hidden group-has-data-[state=open]:hidden'
// ⋯ 平时只是视觉隐藏、始终留在 Tab 序里：鼠标点开对话后再按 Tab 也走得到它，键盘焦点落进行里时现身。
// 负右距挂在按钮上（not-sr-only 会清掉槽位自己的 margin），让 24px 按钮里的图标右缘落在行内容右缘。
export const SIDEBAR_ROW_TRAILING_SHOWN =
  'sr-only *:-mr-1.25 group-hover:not-sr-only group-hover:flex group-has-focus-visible:not-sr-only group-has-focus-visible:flex group-has-data-[state=open]:not-sr-only group-has-data-[state=open]:flex'

/** 仅对本浏览器已查看过且 lastRunId 变化的完成对话显示未读；当前打开的对话不显示。 */
const useUnread = (conversation: Conversation, active: boolean): boolean => {
  const seenRun = useSeenRun(conversation.id)
  return !active && seenRun !== undefined && seenRun !== conversation.lastRunId
}

type SidebarConversationRowProps = {
  conversation: Conversation
  dragging: boolean
  /** 请调用方打开删除确认；删除本身由确认弹窗执行。 */
  onDelete: () => void
  onOpenMembership: () => void
}

/** 侧栏一行对话：打开、改名、归属、标记完成与删除；改对话要有 agent:run，改完各 mutation 自己刷新列表。 */
export function SidebarConversationRow({
  conversation,
  dragging,
  onDelete,
  onOpenMembership,
}: SidebarConversationRowProps) {
  const canWrite = hasPermission(useUser().data, PERMISSION.agentRun)
  const { listeners, setNodeRef, transform } = useDraggable({
    disabled: !canWrite,
    data: { collectionId: conversation.collectionId },
    id: conversation.id,
  })
  const openedId = useParams({ select: (params) => params.conversationId, strict: false })
  const active = openedId === conversation.id
  const [editing, setEditing] = useState(false)
  const rename = useRenameConversation()
  const completion = useSetConversationCompletion()
  const completed = conversation.completedAt !== null
  const unread = useUnread(conversation, active)
  const status = conversationStatus(conversation.activity)
  // 行尾只画还需要人看一眼的状态；跑完没看过的用小点，其余什么都不画。
  const showUnread = unread && status === 'completed'
  const video = conversation.activity.videoGeneration
  const hasMenu = !editing && canWrite
  // 行尾图形悬停时让位给 ⋯，说明挂在整行上，鼠标用户仍看得到是什么状态。
  const statusLabels = [
    ...(status !== 'idle' && needsAttention(status) ? [conversationStatusLabel(status)] : []),
    ...(video === 'none' ? [] : [`视频${mediaStatusLabel(video)}`]),
    ...(showUnread ? ['未读'] : []),
    ...(completed ? ['已完成'] : []),
  ]

  const commitRename = (value: string) => {
    setEditing(false)
    const title = value.trim()
    if (title && title !== conversation.title) {
      rename.mutate(
        { conversationId: conversation.id, title },
        { onError: (error) => toast.error(errorMessageOf(error, '重命名失败')) },
      )
    }
  }

  return (
    // 拖拽绑定整行，避免链接原生拖动吞掉指针事件；编辑标题时禁用拖拽以允许文字选择。
    <div
      className={cn(
        SIDEBAR_ROW_CLASS,
        // 拖动中的行压在侧栏吸顶标题（layer-local-1）之上。
        dragging && 'layer-local-2 opacity-50',
        active ? SIDEBAR_ROW_ACTIVE : SIDEBAR_ROW_MENU_OPEN,
      )}
      ref={setNodeRef}
      title={statusLabels.length ? statusLabels.join('、') : undefined}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      {...(editing || !canWrite ? {} : listeners)}
    >
      {editing ? (
        <input
          aria-label={`重命名 ${conversation.title}`}
          className="min-w-0 flex-1 rounded-xs bg-surface-container-lowest px-1 text-body text-on-surface ui-focus-inline"
          defaultValue={conversation.title}
          onBlur={(event) => commitRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = conversation.title
              event.currentTarget.blur()
            }
          }}
          ref={(element) => element?.focus()}
        />
      ) : (
        <Link
          aria-current={active ? 'page' : undefined}
          className={SIDEBAR_ROW_TITLE_CLASS}
          draggable={false}
          params={{ conversationId: conversation.id }}
          to="/c/$conversationId"
        >
          <span className="min-w-0 flex-1 truncate text-left">{conversation.title}</span>
        </Link>
      )}
      {/* 每件事实一个带名字的图形：出片在跑与轮次在跑互不蕴含，可以同时出现。 */}
      <span
        className={cn(
          'flex shrink-0 items-center gap-1.5 empty:hidden',
          hasMenu && SIDEBAR_ROW_TRAILING_HIDDEN,
        )}
      >
        {needsAttention(status) && <ConversationGlyph status={status} />}
        {video !== 'none' && (
          <span
            aria-label={`视频${mediaStatusLabel(video)}`}
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
          <span aria-label="未读" className="size-2 shrink-0 rounded-full bg-primary" role="img" />
        )}
        {completed && (
          <Icon className="shrink-0 text-on-surface-faint" label="已完成" name="check" size="sm" />
        )}
      </span>
      {hasMenu && (
        <div className={cn(SIDEBAR_ROW_TRAILING_SHOWN, 'shrink-0 items-center')}>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton label={`${conversation.title} 的更多操作`} name="more" size="xs" />
            </MenuTrigger>
            <MenuSurface align="end">
              <MenuItem icon="edit" onSelect={() => setEditing(true)}>
                重命名
              </MenuItem>
              <MenuItem icon="folder" onSelect={onOpenMembership}>
                归属
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
              <MenuItem destructive icon="delete" onSelect={onDelete}>
                删除
              </MenuItem>
            </MenuSurface>
          </MenuRoot>
        </div>
      )}
    </div>
  )
}

/** 轮次状态：等人（审批、回答）用橙点，失败用红色感叹号，在跑用转圈；减少动效时转圈停住。其余不画。 */
function ConversationGlyph({ status }: { status: ConversationStatus }) {
  switch (status) {
    case 'approval':
    case 'question':
      return (
        <span
          aria-label={conversationStatusLabel(status)}
          className="size-2 shrink-0 rounded-full bg-warning ring-3 ring-warning/20"
          role="img"
        />
      )
    case 'failed':
      return (
        <Icon
          className="shrink-0 text-error"
          label={conversationStatusLabel(status)}
          name="alert"
          size="sm"
        />
      )
    case 'running':
      return (
        <Icon
          className="shrink-0 text-on-surface-variant motion-safe:animate-spin"
          label={conversationStatusLabel(status)}
          name="spinner"
          size="sm"
        />
      )
    case 'completed':
    case 'aborted':
    case 'idle':
      return null
  }
}
