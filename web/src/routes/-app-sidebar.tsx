import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import { revealClippedFocus } from './-reveal-clipped-focus'
import { SidebarConversations } from './-sidebar-conversations'

// 侧栏操作行（导航、登录、重试）与对话行同一套行几何，焦点环落在按钮本身。
const SIDEBAR_ACTION_CLASS = cn(SIDEBAR_ROW_CLASS, 'w-full ui-focus')

type AppSidebarProps = {
  collapsed: boolean
  compact?: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

/** 折叠状态由应用壳持有，供拖柄与聊天、面板并排布局统一计算。 */
export function AppSidebar({ collapsed, compact = false, onCollapsedChange }: AppSidebarProps) {
  const rail = collapsed && !compact
  const sidebarId = useId()
  const toggleId = useId()
  const restoreToggleFocusRef = useRef(false)
  useEffect(() => {
    if (!restoreToggleFocusRef.current) return
    restoreToggleFocusRef.current = false
    document.getElementById(toggleId)?.focus()
  }, [collapsed, toggleId])
  const toggleCollapsed = () => {
    // 移动端抽屉开合会切换按钮节点，焦点跟随到可见的侧边栏开关。
    restoreToggleFocusRef.current = compact
    onCollapsedChange(!collapsed)
  }
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const previousPathRef = useRef(pathname)
  useEffect(() => {
    if (previousPathRef.current === pathname) return
    previousPathRef.current = pathname
    if (compact) onCollapsedChange(true)
  }, [compact, onCollapsedChange, pathname])
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
  // 全局帧订阅挂在侧边栏顶层，全部对话页与会话页共用同一份列表缓存。
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
  return (
    <>
      {compact && collapsed ? (
        <IconButton
          className="layer-sidebar fixed top-2 left-3"
          aria-controls={sidebarId}
          aria-expanded={false}
          id={toggleId}
          label="展开侧边栏"
          name="panel-left"
          onClick={toggleCollapsed}
          size="md"
        />
      ) : null}
      <aside
        id={sidebarId}
        aria-label="侧边栏"
        onFocusCapture={(event) => {
          if (!compact && !collapsed) revealClippedFocus(event, () => onCollapsedChange(false))
        }}
        aria-hidden={compact && collapsed ? true : undefined}
        inert={compact && collapsed}
        hidden={compact && collapsed}
        className={cn(
          'layer-sidebar flex h-dvh w-(--layout-app-sidebar-width) shrink-0 flex-col overflow-clip border-r-[0.5px] border-border bg-background',
          compact ? 'fixed top-0 left-0 shadow-[var(--shadow-2)]' : 'sticky top-0',
          compact && collapsed && 'hidden',
        )}
      >
        <div className="flex h-full w-(--layout-app-sidebar-body-width) shrink-0 flex-col">
          <div className="flex h-13 shrink-0 items-center px-2">
            <div
              className={cn('flex min-w-0 flex-1 items-center', rail ? 'justify-center' : 'px-2.5')}
            >
              {!rail && (
                <span className="min-w-0 flex-1 truncate font-home-display text-title-lg font-semibold tracking-[-0.02em] text-on-surface italic">
                  Cue
                </span>
              )}
              <IconButton
                className={cn(!rail && '-mr-2.5')}
                aria-controls={sidebarId}
                aria-expanded={!collapsed}
                id={compact && collapsed ? undefined : toggleId}
                label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
                name="panel-left"
                onClick={toggleCollapsed}
                size="md"
              />
            </div>
          </div>

          <nav aria-label="会话操作" className="flex shrink-0 flex-col">
            <div className="flex flex-col gap-px px-2">
              <SidebarAction
                compact={rail}
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
                compact={rail}
                icon="search"
                kbd="⌘K"
                label="搜索"
                disabled={session.isPending || Boolean(user && !canRead)}
                onClick={openSearch}
                shortcut="Meta+K Control+K"
                title={user && !canRead ? '当前账号没有查看对话权限' : '搜索对话（⌘/Ctrl+K）'}
              />
              <SidebarAction
                compact={rail}
                active={pathname === '/tasks'}
                icon="task"
                label="需求单"
                disabled={session.isPending || Boolean(user && !canReadTasks)}
                onClick={user ? () => navigate({ to: '/tasks' }) : requireLogin}
                title={user && !canReadTasks ? '当前账号没有查看需求单权限' : undefined}
              />
              <SidebarAction
                compact={rail}
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
                  className={cn(
                    'flex h-7 items-center px-2.5 text-caption font-medium text-on-surface-faint',
                    rail && 'sr-only',
                  )}
                  id={governLabelId}
                >
                  治理
                </p>
                <div className="flex flex-col gap-px">
                  <SidebarAction
                    compact={rail}
                    active={pathname === '/conversations'}
                    icon="preview"
                    label="全部对话"
                    onClick={() => void navigate({ to: '/conversations' })}
                  />
                  <SidebarAction
                    compact={rail}
                    active={pathname === '/audit'}
                    icon="chart"
                    label="审计"
                    onClick={() => void navigate({ to: '/audit' })}
                  />
                </div>
              </div>
            ) : null}
          </nav>

          {/* 折叠只隐藏内容，保留筛选、合集展开和列表滚动位置。 */}
          <div
            aria-hidden={collapsed ? true : undefined}
            inert={collapsed}
            hidden={collapsed}
            className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'hidden')}
          >
            {session.isPending ? (
              <p
                className="min-h-0 flex-1 px-4.5 pt-4 text-body-sm text-on-surface-faint"
                role="status"
              >
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
          </div>
          {rail && <div className="min-h-0 flex-1" />}

          <div className="shrink-0 p-2">
            {user ? (
              <CueUserMenu align="top-start" compact={rail} />
            ) : (
              <button
                aria-label="登录"
                className={cn(SIDEBAR_ACTION_CLASS, 'h-11', rail && 'justify-center px-0')}
                onClick={requireLogin}
                type="button"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface-variant">
                  <Icon decorative name="user" size="md" />
                </span>
                {!rail && (
                  <span aria-hidden className="min-w-0 flex-1 truncate text-left">
                    登录
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      </aside>
      {searchDialog}
    </>
  )
}

type SidebarActionProps = {
  compact?: boolean
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
  compact = false,
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
        compact && 'justify-center px-0',
      )}
      disabled={disabled}
      onClick={onClick}
      title={title ?? (compact ? label : undefined)}
      type="button"
    >
      {emphasis ? (
        <span className="grid size-(--icon-md) shrink-0 place-items-center rounded-full bg-on-surface text-surface-container-lowest">
          <Icon decorative name={icon} size="xs" />
        </span>
      ) : (
        <Icon className="shrink-0 text-on-surface-variant" decorative name={icon} size="md" />
      )}
      {!compact && (
        <span aria-hidden className="min-w-0 flex-1 truncate text-left">
          {label}
        </span>
      )}
      {kbd && !compact && (
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
