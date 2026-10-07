import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CueUserMenu } from '@/features/auth'
import {
  ConversationSearchDialog,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_CLASS,
  useLiveConversations,
} from '@/features/conversations'
import { canAuditAll, hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useShellChrome } from '@/shared/shell'
import { IconButton } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'
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
  const expandTip = useTabTooltip()
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

  const requestComposerFocus = useShellChrome().composerFocus?.request
  /** 去首页新建任务；从合集行进来时带上合集，首页预选它。 */
  const startNew = useCallback(
    (collectionId?: string) => {
      if (session.isPending) return
      if (!user) return requireLogin()
      if (!canStart) return
      setSearchOpen(false)
      // 已在首页时路由不变，抽屉不会随路由折叠，这里主动收起，焦点才能落到输入框上。
      if (compact) onCollapsedChange(true)
      requestComposerFocus?.()
      void navigate(
        collectionId === undefined
          ? { to: '/' }
          : { search: { collection: collectionId }, to: '/' },
      )
    },
    [
      canStart,
      compact,
      navigate,
      onCollapsedChange,
      requestComposerFocus,
      requireLogin,
      session.isPending,
      user,
    ],
  )

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
      {/* 侧栏浅灰底；桌面与主区的分界线由侧栏拖柄画出，紧凑屏是带投影的抽屉。 */}
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
          'layer-sidebar flex h-dvh w-(--layout-app-sidebar-width) shrink-0 flex-col overflow-clip bg-surface-container-low',
          compact ? 'fixed top-0 left-0 shadow-[var(--shadow-2)]' : 'sticky top-0',
          compact && collapsed && 'hidden',
        )}
      >
        <div className="flex h-full w-(--layout-app-sidebar-body-width) shrink-0 flex-col">
          <div className="flex h-14 shrink-0 items-center px-2">
            {rail ? (
              // 图标栏只留品牌标志，它兼作展开开关：悬停或键盘聚焦时换成侧栏图标提示可展开。
              <TooltipRoot {...expandTip.rootProps}>
                <TooltipTrigger asChild {...expandTip.triggerProps}>
                  <button
                    aria-controls={sidebarId}
                    aria-expanded={false}
                    aria-label="展开侧边栏"
                    className="group mx-auto grid size-10 ui-state cursor-pointer place-items-center rounded-md ui-focus"
                    id={toggleId}
                    onClick={toggleCollapsed}
                    type="button"
                  >
                    <BrandMark className="group-hover:hidden group-focus-visible:hidden" />
                    <Icon
                      className="hidden text-on-surface-variant group-hover:block group-focus-visible:block"
                      decorative
                      name="panel-left"
                      size="md"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">展开侧边栏</TooltipContent>
              </TooltipRoot>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2 pl-1.5">
                <BrandMark />
                <span className="min-w-0 flex-1 truncate font-home-display text-title-lg font-semibold tracking-[-0.02em] text-on-surface italic">
                  Cue
                </span>
                <IconButton
                  aria-controls={sidebarId}
                  aria-expanded={!collapsed}
                  id={compact && collapsed ? undefined : toggleId}
                  label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
                  name="panel-left"
                  onClick={toggleCollapsed}
                  size="md"
                />
              </div>
            )}
          </div>

          <nav aria-label="会话操作" className="flex shrink-0 flex-col">
            <div className="flex flex-col gap-0.5 px-2">
              <SidebarAction
                compact={rail}
                emphasis
                icon="add"
                kbd="⌘⌥N"
                label="新建任务"
                disabled={session.isPending || Boolean(user && !canStart)}
                disabledReason={user && !canStart ? '当前账号没有新建任务权限' : undefined}
                onClick={startNew}
                shortcut="Meta+Alt+N Control+Alt+N"
              />
              <SidebarAction
                compact={rail}
                hint="搜索任务"
                icon="search"
                kbd="⌘K"
                label="搜索"
                disabled={session.isPending || Boolean(user && !canRead)}
                disabledReason={user && !canRead ? '当前账号没有查看任务权限' : undefined}
                onClick={openSearch}
                shortcut="Meta+K Control+K"
              />
              <SidebarAction
                compact={rail}
                active={pathname === '/tasks'}
                icon="task"
                label="需求单"
                disabled={session.isPending || Boolean(user && !canReadTasks)}
                disabledReason={user && !canReadTasks ? '当前账号没有查看需求单权限' : undefined}
                onClick={user ? () => navigate({ to: '/tasks' }) : requireLogin}
              />
              <SidebarAction
                compact={rail}
                active={pathname === '/library'}
                icon="library"
                label="资料库"
                disabled={session.isPending || Boolean(user && !canReadLibrary)}
                disabledReason={
                  user && !canReadLibrary ? '当前账号没有查看出片记录权限' : undefined
                }
                onClick={user ? () => navigate({ to: '/library' }) : requireLogin}
              />
            </div>
            {canGovern ? (
              <div aria-labelledby={governLabelId} className="mt-3 px-2" role="group">
                <p
                  className={cn(
                    'flex h-8 items-center px-2.5 text-label font-semibold text-on-surface-variant',
                    rail && 'sr-only',
                  )}
                  id={governLabelId}
                >
                  治理
                </p>
                <div className="flex flex-col gap-0.5">
                  <SidebarAction
                    compact={rail}
                    active={pathname === '/conversations'}
                    icon="preview"
                    label="全部任务"
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
              <SidebarConversations onStartInCollection={startNew} />
            ) : (
              <div className="min-h-0 flex-1 px-4.5 pt-4">
                <p className="text-body-sm text-on-surface-faint">登录后查看任务</p>
              </div>
            )}
          </div>
          {rail && <div className="min-h-0 flex-1" />}

          <div className="shrink-0 px-2 pb-2">
            <div aria-hidden className="mx-1.5 mb-2 h-px bg-hairline" />
            {user ? (
              <CueUserMenu align="top-start" compact={rail} />
            ) : (
              <button
                aria-label="登录"
                className={cn(
                  SIDEBAR_ACTION_CLASS,
                  'h-12 px-2',
                  rail && 'mx-auto size-10 justify-center px-0',
                )}
                onClick={requireLogin}
                type="button"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface-variant">
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
  /** 置灰的原因，置灰时悬停或按 Tab 移上去弹出；没有原因（如还在确认登录）就不弹。 */
  disabledReason?: string | undefined
  /** 主操作：深色实心按钮，快捷键常驻右侧；绿色留给「生成」。 */
  emphasis?: boolean
  /** 图标栏提示里的名字，缺省同 label；label 太短说不清时才传，如「搜索」提示成「搜索任务」。 */
  hint?: string
  icon: IconName
  kbd?: string
  label: string
  onClick?: (() => void) | undefined
  shortcut?: string
}

/**
 * 侧栏导航行。图标栏里提示名字（带快捷键），置灰时提示原因，都走共用 Tooltip、出在右侧；
 * 展开且可用时名字与快捷键已在行上，不弹提示。
 * 置灰用 aria-disabled：原生 disabled 收不到指针、进不了 Tab 序，原因就弹不出来；置灰时点击与 Enter / Space 都被拦下。
 */
function SidebarAction({
  active = false,
  compact = false,
  disabled = false,
  disabledReason,
  emphasis = false,
  hint,
  icon,
  kbd,
  label,
  onClick,
  shortcut,
}: SidebarActionProps) {
  const { rootProps, triggerProps } = useTabTooltip()
  const tip = disabled ? disabledReason : compact ? (hint ?? label) : undefined
  return (
    // 提示始终挂着、只在有内容时弹：权限读完置灰与否变化时按钮不重建，焦点不丢。
    <TooltipRoot {...rootProps} open={rootProps.open && tip !== undefined}>
      <TooltipTrigger asChild {...triggerProps}>
        <button
          aria-current={active ? 'page' : undefined}
          aria-disabled={disabled ? true : undefined}
          aria-label={label}
          aria-keyshortcuts={shortcut}
          className={cn(
            SIDEBAR_ACTION_CLASS,
            'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
            emphasis
              ? // 深色底上 ui-state 的禁用字色看不清，禁用只整体压淡。内距与间距沿用行几何，图标与下方导航图标同一列。
                'mb-2 h-10 bg-inverse-surface font-semibold text-inverse-on-surface shadow-[var(--shadow-1)] hover:shadow-[var(--shadow-2)] aria-disabled:text-inverse-on-surface'
              : 'text-on-surface-variant hover:not-aria-disabled:text-on-surface',
            active && cn(SIDEBAR_ROW_ACTIVE, 'text-on-surface'),
            compact && 'mx-auto size-10 justify-center px-0',
          )}
          onClick={(event) => {
            if (disabled) {
              event.preventDefault()
              return
            }
            onClick?.()
          }}
          type="button"
        >
          <Icon
            className={cn(
              'shrink-0',
              emphasis
                ? 'text-inverse-on-surface'
                : active
                  ? 'text-on-surface'
                  : 'text-on-surface-variant',
            )}
            decorative
            name={icon}
            size="md"
          />
          {!compact && (
            <span aria-hidden className="min-w-0 flex-1 truncate text-left">
              {label}
            </span>
          )}
          {kbd && !compact && (
            <kbd
              aria-hidden
              className={cn(
                'text-caption font-medium tracking-wide',
                emphasis
                  ? 'opacity-60'
                  : 'text-on-surface-faint opacity-0 transition-opacity duration-(--dur-s) group-hover:opacity-100',
              )}
            >
              {kbd}
            </kbd>
          )}
        </button>
      </TooltipTrigger>
      {tip !== undefined && (
        <TooltipContent side="right">
          {tip}
          {/* 图标栏里行上没有快捷键，跟在名字后面；置灰时只说原因。 */}
          {kbd && compact && !disabled && (
            <kbd className="ml-2 font-sans text-inverse-on-surface/60">{kbd}</kbd>
          )}
        </TooltipContent>
      )}
    </TooltipRoot>
  )
}

/** 品牌标志：深色圆角块里一个衬线斜体「C」，折叠成图标栏时单独出现。 */
function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7.5 shrink-0 place-items-center rounded-sm bg-inverse-surface font-home-display text-title font-bold text-inverse-on-surface italic',
        className,
      )}
    >
      C
    </span>
  )
}
