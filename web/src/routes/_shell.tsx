import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { createFileRoute, Outlet, useMatches, useNavigate } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { z } from 'zod'
import { LoginDialog } from '@/features/auth'
import { ShellChromeContext } from '@/shared/shell'
import { IconButton } from '@/shared/ui/button'
import { WorkbenchLayoutProvider } from '@/shared/workbench'
import { AppContentPane } from './-app-content-pane'
import { AppResizeHandle } from './-app-resize-handle'
import { AppRightPanel } from './-app-right-panel'
import {
  CHAT_MIN,
  resolveShellLayout,
  resizeContent,
  resizeSidebar,
  selectContentPane,
  SIDEBAR_WIDTH,
  WORKBENCH_WIDTH,
  type ContentPane,
  type ShellLayoutState,
} from './-app-shell-layout'
import { AppSidebar } from './-app-sidebar'
import { LoginPromptProvider } from './-login-prompt'
import { useShellLayout } from './-use-shell-layout'

const ShellSearchSchema = z.object({ ssoError: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_shell')({
  component: AppShell,
  validateSearch: ShellSearchSchema,
})

/** 壳持有布局偏好；视口只派生几何，不回写桌面的排列与宽度。 */
function AppShell() {
  const navigate = useNavigate()
  const matches = useMatches()
  const hasWorkbench =
    [...matches].reverse().find((match) => match.staticData.rightPanel !== undefined)?.staticData
      .rightPanel !== undefined
  const { ssoError } = Route.useSearch()
  const [loginOpen, setLoginOpen] = useState(Boolean(ssoError))
  const { state, update, persist } = useShellLayout()
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [mobileSidebarCollapsed, setMobileSidebarCollapsed] = useState(true)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  useEffect(() => {
    const sync = () => setViewport(window.innerWidth)
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  const geometry = resolveShellLayout({ viewport, hasWorkbench, state })
  const { compact, sideBySide, mode, sidebarWidth, contentWidth, chatWidth, workbenchWidth } =
    geometry
  const contentRef = useRef<HTMLDivElement>(null)
  const focusRequestRef = useRef<{ pane: ContentPane; collapsed: boolean } | null>(null)
  useLayoutEffect(() => {
    const request = focusRequestRef.current
    if (!request) return
    focusRequestRef.current = null
    const selector = request.collapsed ? '[data-pane-restore]' : '[data-pane-body]'
    contentRef.current
      ?.querySelector<HTMLElement>(`[data-pane="${request.pane}"] ${selector}`)
      ?.focus({ preventScroll: true })
  }, [mode])

  const dragRef = useRef<{ state: ShellLayoutState; width: number } | null>(null)
  const cancelResize = () => {
    const origin = dragRef.current
    if (origin) update(() => origin.state, false)
    dragRef.current = null
  }
  const finishResize = () => {
    persist()
    dragRef.current = null
  }
  const expandPane = useCallback(
    (pane: ContentPane) => {
      update((current) => selectContentPane(current, pane, 'split', sideBySide))
    },
    [sideBySide, update],
  )
  const collapsePane = (pane: ContentPane) => {
    const body = contentRef.current?.querySelector(`[data-pane="${pane}"]`)
    if (body?.contains(document.activeElement)) focusRequestRef.current = { pane, collapsed: true }
    const other = pane === 'chat' ? 'workbench' : 'chat'
    update((current) => selectContentPane(current, other, other, sideBySide))
  }
  const swapPanes = () =>
    update((current) => ({
      ...current,
      firstPane: current.firstPane === 'chat' ? 'workbench' : 'chat',
    }))
  const openWorkbench = useCallback(
    (reason: 'automatic' | 'explicit') => {
      update((current) => {
        if (reason === 'automatic') {
          return current.mode === null
            ? { ...current, activePane: 'workbench', mode: 'split', contentClip: null }
            : current
        }
        return selectContentPane(
          current,
          'workbench',
          current.mode === 'workbench' ? 'workbench' : 'split',
          sideBySide,
        )
      })
    },
    [sideBySide, update],
  )
  const layout = {
    compact,
    sideBySide,
    collapsed: mode === 'chat',
    onCollapsedChange: (collapsed: boolean) =>
      collapsed ? collapsePane('workbench') : expandPane('workbench'),
    onOpen: openWorkbench,
  }
  const chrome = {
    sidebarOverlay: compact,
    ...(hasWorkbench && !compact
      ? {
          chat: {
            onCollapse: () => collapsePane('chat'),
          },
          onSwapPanes: swapPanes,
        }
      : {}),
  }
  const handleLoginOpenChange = useCallback(
    (open: boolean) => {
      setLoginOpen(open)
      if (!open && ssoError) void navigate({ replace: true, search: {}, to: '.' })
    },
    [navigate, ssoError],
  )
  const requireLogin = useCallback(() => setLoginOpen(true), [])
  const panes: ContentPane[] = ['chat', 'workbench']
  const shellVars = {
    '--layout-app-sidebar-width': `${sidebarWidth}px`,
    '--layout-app-sidebar-body-width': `${!compact && state.sidebarCollapsed ? sidebarWidth : Math.max(SIDEBAR_WIDTH.min, sidebarWidth)}px`,
  } as CSSProperties

  return (
    <LoginPromptProvider value={requireLogin}>
      <ShellChromeContext value={chrome}>
        <div className="relative flex h-dvh overflow-hidden" style={shellVars}>
          <AppSidebar
            collapsed={compact ? mobileSidebarCollapsed : state.sidebarCollapsed}
            compact={compact}
            onCollapsedChange={(collapsed) =>
              compact
                ? setMobileSidebarCollapsed(collapsed)
                : update((current) => ({
                    ...current,
                    sidebarCollapsed: collapsed,
                    sidebarClipWidth: null,
                  }))
            }
          />
          {!compact && (
            <AppResizeHandle
              label="调整侧栏宽度"
              position={sidebarWidth}
              value={sidebarWidth}
              min={SIDEBAR_WIDTH.collapsed}
              max={SIDEBAR_WIDTH.max}
              onResizeStart={() => {
                dragRef.current = { state, width: sidebarWidth }
              }}
              onResize={(delta, input) => {
                const origin = dragRef.current
                if (origin)
                  update((current) => resizeSidebar(current, origin.width + delta, input), false)
              }}
              onResizeEnd={finishResize}
              onResizeCancel={cancelResize}
              onReset={() =>
                update((current) => ({
                  ...current,
                  sidebarCollapsed: false,
                  sidebarWidth: SIDEBAR_WIDTH.default,
                  sidebarClipWidth: null,
                }))
              }
            />
          )}
          <div
            className="relative flex min-w-0 flex-1"
            ref={contentRef}
            style={{ flexDirection: state.firstPane === 'chat' ? 'row' : 'row-reverse' }}
          >
            <DndContext
              sensors={sensors}
              onDragEnd={({ active, over }) => {
                if (over && active.id !== over.id) swapPanes()
              }}
            >
              {panes.map((pane) => (
                <AppContentPane
                  key={pane}
                  pane={pane}
                  width={pane === 'chat' ? chatWidth : workbenchWidth}
                  minWidth={sideBySide ? (pane === 'chat' ? CHAT_MIN : WORKBENCH_WIDTH.min) : 0}
                  alignEnd={pane !== state.firstPane}
                  collapsed={pane === 'chat' ? mode === 'workbench' : mode === 'chat'}
                  canReorder={hasWorkbench && !compact}
                  onReveal={() => update((current) => ({ ...current, contentClip: null }))}
                  onExpand={() => {
                    focusRequestRef.current = { pane, collapsed: false }
                    expandPane(pane)
                  }}
                >
                  {pane === 'chat' ? (
                    <Outlet />
                  ) : (
                    <WorkbenchLayoutProvider layout={layout}>
                      <AppRightPanel />
                    </WorkbenchLayoutProvider>
                  )}
                </AppContentPane>
              ))}
            </DndContext>
            {hasWorkbench && sideBySide && (
              <AppResizeHandle
                label="调整面板宽度"
                position={state.firstPane === 'chat' ? chatWidth : workbenchWidth}
                value={workbenchWidth}
                min={0}
                max={contentWidth}
                onResizeStart={() => {
                  dragRef.current = { state, width: workbenchWidth }
                }}
                onResize={(delta, input) => {
                  const origin = dragRef.current
                  if (origin)
                    update(
                      (current) =>
                        resizeContent(
                          current,
                          origin.width + (origin.state.firstPane === 'workbench' ? delta : -delta),
                          contentWidth,
                          input,
                        ),
                      false,
                    )
                }}
                onResizeEnd={finishResize}
                onResizeCancel={cancelResize}
                onReset={() =>
                  update((current) => ({
                    ...current,
                    mode: 'split',
                    contentClip: null,
                    workbenchWidth: WORKBENCH_WIDTH.default,
                  }))
                }
              />
            )}
            {hasWorkbench && compact && (
              <IconButton
                className="layer-sidebar absolute top-2 right-2"
                label={mode === 'chat' ? '打开右侧面板' : '展开对话'}
                name={mode === 'chat' ? 'grid' : 'message'}
                onClick={() => expandPane(mode === 'chat' ? 'workbench' : 'chat')}
                size="md"
              />
            )}
          </div>
        </div>
      </ShellChromeContext>
      <LoginDialog open={loginOpen} onOpenChange={handleLoginOpenChange} ssoErrorCode={ssoError} />
    </LoginPromptProvider>
  )
}
