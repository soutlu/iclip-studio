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

/** 侧栏一行对话：打开、改名、移到合集、标记完成与删除；改对话要有 agent:run，改完各 mutation 自己刷新列表。 */
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
  const { close, editing, returnRef, start } = useSidebarRowEditing<HTMLAnchorElement>()
  const rename = useRenameConversation()
  const completion = useSetConversationCompletion()
  const [tipOpen, setTipOpen] = useState(false)
  const completed = conversation.completedAt !== null
  const unread = useUnread(conversation, active)
  const status = conversationStatus(conversation.activity)
  // 行尾只画还需要人看一眼的状态；跑完没看过的用小点，其余什么都不画。
  const showUnread = unread && status === 'completed'
  const video = conversation.activity.videoGeneration
  const videoLabel = video === 'none' ? undefined : `视频${mediaStatusLabel(video)}`
  // 整行的提示条按行尾顺序把这一行的状态全列出来，看图形的人不用猜。
  const statusLabels = [
    ...(needsAttention(status) ? [conversationStatusLabel(status)] : []),
    ...(videoLabel === undefined ? [] : [videoLabel]),
    ...(showUnread ? [UNREAD_LABEL] : []),
    ...(completed ? ['已完成'] : []),
  ]

  if (editing)
    return (
      <SidebarRowEditor
        // 正打开的那一行保持加粗，进出编辑字形不变。
        className={cn(active && 'font-semibold')}
        failureMessage="重命名失败"
        initialValue={conversation.title}
        label={`重命名 ${conversation.title}`}
        onClose={close}
        onSubmit={(title) => rename.mutateAsync({ conversationId: conversation.id, title })}
      />
    )

  return (
    // 提示始终挂着、只在有状态时弹：状态来去时行不重建，键盘焦点不丢。
    // 键盘移进标题链接时聚焦冒泡上来也弹；⋯ 按钮自己拦下了聚焦打开，焦点还给它时这里也不弹。
    <TooltipRoot onOpenChange={setTipOpen} open={tipOpen && statusLabels.length > 0 && !dragging}>
      <TooltipTrigger asChild>
        {/* 拖拽绑定整行，避免链接原生拖动吞掉指针事件；改名时整行换成编辑行，不挂拖拽。 */}
        <div
          className={cn(
            SIDEBAR_ROW_CLASS,
            // 拖动中的行压在侧栏吸顶标题（layer-local-1）之上。
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
            {/* 标了收尾的对话标题降为辅助色；正打开的那一行保持常规强调。 */}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-left',
                completed && !active && 'text-on-surface-faint',
              )}
            >
              {conversation.title}
            </span>
          </Link>
          {/* 每件事实一个带名字的图形：出片在跑与轮次在跑互不蕴含，可以同时出现。 */}
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
              // 未读用墨色，绿色只留给生成。
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
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton label={`${conversation.title} 的更多操作`} name="more" size="xs" />
                </MenuTrigger>
                <MenuSurface align="end">
                  <MenuItem icon="edit" onSelect={start}>
                    重命名
                  </MenuItem>
                  <MenuItem icon="folder" onSelect={onOpenMembership}>
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
                  <MenuItem destructive icon="delete" onSelect={onDelete}>
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
}

/**
 * 轮次状态。等人（审批、回答）与失败要用户动手，橙点、红色感叹号后面直接写短词，字用中性色；
 * 在跑只画转圈，减少动效时停住。
 */
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
    // 橙点外有一圈 3px 光晕，字与图形隔 6px 才不贴着光晕。
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
