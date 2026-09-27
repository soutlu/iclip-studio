import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useId, useState } from 'react'
import { CueUserMenu } from '@/features/auth'
import {
  ConversationSearchDialog,
  SIDEBAR_ROW_CLASS,
  useLiveConversations,
} from '@/features/conversations'
import { canAuditAll, hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { useLoginPrompt } from './-login-prompt'
import { SidebarConversations } from './-sidebar-conversations'

// 侧栏操作行（导航、登录、重试）与对话行同一套行几何，焦点环落在按钮本身。
const SIDEBAR_ACTION_CLASS = cn(SIDEBAR_ROW_CLASS, 'w-full ui-focus')

type AppSidebarProps = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

/** 折叠状态由应用壳持有，供拖柄与聊天、面板并排布局统一计算。 */
export function AppSidebar({ collapsed, onCollapsedChange }: AppSidebarProps) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [searchOpen, setSearchOpen] = useState(false)
  const session = useUser()
  const { data: user } = session
  const requireLogin = useLoginPrompt()
  const canRead = hasPermission(user, PERMISSION.agentRead)
  const canStart = hasPermission(user, PERMISSION.agentRun)
  const canReadTasks = hasPermission(user, PERMISSION.tasksRead)
  const canReadLibrary = hasPermission(user, PERMISSION.generationRead)
  const canGovern = canAuditAll(user)
  const governLabelId = useId()
  // 全局帧订阅挂在侧栏顶层：折叠时对话区不渲染，全部对话页与会话页仍要靠它刷新列表缓存。
  useLiveConversations(canRead)

  const startNew = useCallback(() => {
    if (session.isPending) return
    if (!user) return requireLogin()
    if (!canStart) return
    setSearchOpen(false)
    void navigate({ to: '/' })
  }, [canStart, navigate, requireLogin, session.isPending, user])

  const openSearch = useCallback(() => {
    if (session.isPending) return
    if (!user) return requireLogin()
    if (canRead) setSearchOpen(true)
  }, [canRead, requireLogin, session.isPending, user])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey
      )
        return
      if (event.key.toLowerCase() === 'k' && !event.altKey) {
        event.preventDefault()
        openSearch()
      } else if (event.altKey && (event.code === 'KeyN' || event.key.toLowerCase() === 'n')) {
        // 避开浏览器的新窗口快捷键；code 兼容 macOS Option 键改变字符。
        event.preventDefault()
        startNew()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSearch, startNew])

  const searchDialog = (
    <ConversationSearchDialog onOpenChange={setSearchOpen} open={searchOpen && canRead} />
  )
  // 收起时只保留页头展开钮；搜索弹窗仍可由快捷键打开。
  if (collapsed) {
    return (
      <>
        <IconButton
          className="layer-sidebar fixed top-2 left-3"
          label="展开侧边栏"
          name="panel-left"
          onClick={() => onCollapsedChange(false)}
          size="md"
        />
        {searchDialog}
      </>
    )
  }

  return (
    <aside
      className={cn(
        'layer-sidebar flex h-dvh w-(--layout-app-sidebar-width) shrink-0 flex-col border-r-[0.5px] border-border bg-background',
        'max-sm:fixed max-sm:top-0 max-sm:left-0 max-sm:shadow-[var(--shadow-2)] sm:sticky sm:top-0',
      )}
    >
      <div className="flex h-13 shrink-0 items-center px-2">
        <div className="flex min-w-0 flex-1 items-center px-2.5">
          <span className="min-w-0 flex-1 truncate font-home-display text-title-lg font-semibold tracking-[-0.02em] text-on-surface italic">
            Cue
          </span>
          {/* 负右距让图标右缘与各行尾部内容对齐。 */}
          <IconButton
            className="-mr-2.5"
            label="折叠侧边栏"
            name="panel-left"
            onClick={() => onCollapsedChange(true)}
            size="md"
          />
        </div>
      </div>

      <nav aria-label="会话操作" className="flex shrink-0 flex-col">
        <div className="flex flex-col gap-px px-2">
          <SidebarAction
            emphasis
            icon="add"
            kbd="⌘⌥N"
            label="新建任务"
            disabled={session.isPending || Boolean(user && !canStart)}
            onClick={startNew}
            shortcut="Meta+Alt+N Control+Alt+N"
            title={user && !canStart ? '当前账号没有新建任务权限' : '新建任务（⌘/Ctrl+Alt+N）'}
          />
          <SidebarAction
            icon="search"
            kbd="⌘K"
            label="搜索"
            disabled={session.isPending || Boolean(user && !canRead)}
            onClick={openSearch}
            shortcut="Meta+K Control+K"
            title={user && !canRead ? '当前账号没有查看对话权限' : '搜索对话（⌘/Ctrl+K）'}
          />
        </div>
        <div className="mt-2 flex flex-col gap-px px-2">
          <SidebarAction
            active={pathname === '/tasks'}
            icon="task"
            label="需求单"
            disabled={session.isPending || Boolean(user && !canReadTasks)}
            onClick={user ? () => navigate({ to: '/tasks' }) : requireLogin}
            title={user && !canReadTasks ? '当前账号没有查看需求单权限' : undefined}
          />
          <SidebarAction
            active={pathname === '/library'}
            icon="library"
            label="资料库"
            disabled={session.isPending || Boolean(user && !canReadLibrary)}
            onClick={user ? () => navigate({ to: '/library' }) : requireLogin}
            title={user && !canReadLibrary ? '当前账号没有查看出片记录权限' : undefined}
          />
        </div>
        {canGovern ? (
          <div aria-labelledby={governLabelId} className="mt-3 px-2" role="group">
            <p
              className="flex h-7 items-center px-2.5 text-caption font-medium text-on-surface-faint"
              id={governLabelId}
            >
              治理
            </p>
            <div className="flex flex-col gap-px">
              <SidebarAction
                active={pathname === '/conversations'}
                icon="preview"
                label="全部对话"
                onClick={() => void navigate({ to: '/conversations' })}
              />
              <SidebarAction
                active={pathname === '/audit'}
                icon="chart"
                label="审计"
                onClick={() => void navigate({ to: '/audit' })}
              />
            </div>
          </div>
        ) : null}
      </nav>

      {/* 未登录时保留弹性空间，使账户区保持底部对齐。 */}
      {session.isPending ? (
        <p className="min-h-0 flex-1 px-4.5 pt-4 text-body-sm text-on-surface-faint" role="status">
          正在确认登录状态…
        </p>
      ) : session.isError ? (
        <div className="min-h-0 flex-1 px-2 pt-4">
          <p className="px-2.5 text-body-sm text-error" role="alert">
            读取登录状态失败
          </p>
          <button
            className={cn(SIDEBAR_ACTION_CLASS, 'mt-2')}
            disabled={session.isFetching}
            onClick={() => void session.refetch()}
            type="button"
          >
            {session.isFetching ? '重试中…' : '重试读取登录状态'}
          </button>
        </div>
      ) : user ? (
        <SidebarConversations />
      ) : (
        <div className="min-h-0 flex-1 px-4.5 pt-4">
          <p className="text-body-sm text-on-surface-faint">登录后查看对话</p>
        </div>
      )}

      <div className="shrink-0 p-2">
        {user ? (
          <CueUserMenu align="top-start" />
        ) : (
          <button
            aria-label="登录"
            className={cn(SIDEBAR_ACTION_CLASS, 'h-11')}
            onClick={requireLogin}
            type="button"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface-variant">
              <Icon decorative name="user" size="md" />
            </span>
            <span aria-hidden className="min-w-0 flex-1 truncate text-left">
              登录
            </span>
          </button>
        )}
      </div>
      {searchDialog}
    </aside>
  )
}

type SidebarActionProps = {
  active?: boolean
  disabled?: boolean
  /** 主操作：图标放进实心圆，文字加粗。 */
  emphasis?: boolean
  icon: IconName
  kbd?: string
  label: string
  onClick?: (() => void) | undefined
  shortcut?: string
  title?: string | undefined
}

function SidebarAction({
  active = false,
  disabled = false,
  emphasis = false,
  icon,
  kbd,
  label,
  onClick,
  shortcut,
  title,
}: SidebarActionProps) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      className={cn(
        SIDEBAR_ACTION_CLASS,
        'disabled:cursor-not-allowed disabled:opacity-50',
        (active || emphasis) && 'font-medium',
        active && 'bg-state-active',
      )}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {emphasis ? (
        // 20px 实心圆用负外距收进 16px 图标位，文字仍与其他行对齐。
        <span className="-m-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-on-surface text-surface-container-lowest">
          <Icon decorative name={icon} size="xs" />
        </span>
      ) : (
        <Icon className="shrink-0 text-on-surface-variant" decorative name={icon} size="md" />
      )}
      <span aria-hidden className="min-w-0 flex-1 truncate text-left">
        {label}
      </span>
      {kbd && (
        <kbd
          aria-hidden
          className={cn(
            'rounded-xs border border-border px-1 text-caption text-on-surface-faint',
            'opacity-0 transition-opacity duration-(--dur-s) group-hover:opacity-100',
          )}
        >
          {kbd}
        </kbd>
      )}
    </button>
  )
}
