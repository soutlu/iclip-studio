import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { useConversationReadOnly } from '@/shared/transcript/use-conversation-read-only'
import { useTranscript } from '@/shared/transcript/use-transcript'
import type { TranscriptItem } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useShellChrome } from '@/shared/shell'
import { IconButton } from '@/shared/ui/button'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import type { Artifact, ArtifactEntry, WorkbenchFrame } from './artifact'
import { useArtifactSearch, useOpenArtifact } from './artifact-search'
import { composeArtifacts, isStanding, pickArtifact, type ArtifactRegistry } from './registry'
import { useArtifactCreation } from './use-artifact-creation'
import { WORKBENCH_BUTTON_CLASS } from './workbench-button'
import { useWorkbenchRegistry } from './use-workbench-registry'
import { useWorkbenchOpenRequest } from './use-workbench-open-request'
import { Chooser, type ChooserRow } from './workbench-chooser'
import { CreateMenu } from './workbench-create'
import { WorkbenchHeaderSlotContext } from './workbench-header-slot-context'
import { WorkbenchLayoutContext } from './workbench-layout-context'
import { WorkbenchRail } from './workbench-rail'
import { useWorkspaceFiles, workspaceQueryKeys } from './workspace.api'

const toolFrames = (items: readonly TranscriptItem[]): WorkbenchFrame[] =>
  items.flatMap((item) =>
    item.kind !== 'turn'
      ? []
      : item.steps.flatMap((step) =>
          step.frames.flatMap((frame) =>
            frame.kind !== 'tool'
              ? []
              : [
                  {
                    toolCallId: frame.toolCallId,
                    view: frame.view ?? 'generic',
                    ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
                    ...(frame.display === undefined ? {} : { display: frame.display }),
                    ...(frame.agentRefs === undefined ? {} : { agentRefs: frame.agentRefs }),
                  },
                ],
          ),
        ),
  )

const isStandingType = (registry: ArtifactRegistry, type: string): boolean => {
  const entry = registry.resolve(type)
  return entry !== undefined && isStanding(entry)
}

const artifactRow = (entry: ArtifactEntry, artifact: Artifact): ChooserRow => {
  const detail = entry.detail?.(artifact.source)
  return {
    artifactId: artifact.id,
    icon: entry.icon,
    key: artifact.id,
    label: artifact.title,
    ...(detail === undefined ? {} : { detail }),
  }
}

const chooserRows = (registry: ArtifactRegistry, artifacts: readonly Artifact[]): ChooserRow[] => {
  const standing = registry.standing().flatMap((entry): ChooserRow[] => {
    const own = artifacts.filter((candidate) => candidate.type === entry.type)
    if (own.length === 0) {
      return entry.empty === undefined
        ? []
        : [{ detail: entry.empty, icon: entry.icon, key: entry.type, label: entry.label }]
    }
    return own.map((artifact) => artifactRow(entry, artifact))
  })
  const fromFrames = artifacts.flatMap((artifact): ChooserRow[] => {
    const entry = registry.resolve(artifact.type)
    return entry === undefined || isStanding(entry) ? [] : [artifactRow(entry, artifact)]
  })
  return [...standing, ...fromFrames]
}

/** 工作台顶栏：48 高、没有底线，左边页签（或标题），右边 `end`。 */
function WorkbenchBar({ children, end }: { children: ReactNode; end: ReactNode }) {
  const chrome = useShellChrome()
  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center justify-between gap-2.5 px-3',
        chrome.sidebarOverlay && 'px-14',
      )}
      data-pane-drag-handle
    >
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
      <div className="flex shrink-0 items-center gap-1.5">{end}</div>
    </div>
  )
}

type WorkbenchHostProps = {
  conversationId: string
}

export function WorkbenchHost({ conversationId }: WorkbenchHostProps) {
  const registry = useWorkbenchRegistry()
  const chrome = useShellChrome()
  const queryClient = useQueryClient()
  const connection = use(TranscriptConnectionContext)
  const artifactId = useArtifactSearch()
  const openArtifact = useOpenArtifact()
  const files = useWorkspaceFiles(conversationId)
  const { view } = useTranscript(conversationId)
  const readOnly = useConversationReadOnly(view)
  const frames = useMemo(() => toolFrames(view.items), [view.items])
  const { openToken, requestOpen } = useWorkbenchOpenRequest()
  const layout = use(WorkbenchLayoutContext)
  if (layout === null) throw new Error('WorkbenchHost 要在 WorkbenchLayoutProvider 里用')
  const { compact, onCollapsedChange, onOpen, railSlot, sideBySide } = layout
  const previousOpenRef = useRef<{ selectedId: string | undefined; token: number }>({
    selectedId: undefined,
    token: openToken,
  })
  // 顶栏右侧给当前页签放控件的地方（见 WorkbenchHeaderActions）
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  // 用键盘关掉页签后，焦点落到接着选中的页签上
  const refocusTabRef = useRef(false)

  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchSessions((update) => {
      if (update.kind !== 'reconnected') return
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all(conversationId) })
    })
  }, [connection, conversationId, queryClient])

  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchFs(
      conversationId,
      [''],
      (changes) => {
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.files(conversationId) })
        for (const change of changes) {
          void queryClient.invalidateQueries({
            queryKey: workspaceQueryKeys.file(conversationId, change.path),
          })
        }
      },
      { recursive: true },
    )
  }, [connection, conversationId, queryClient])

  const artifacts = composeArtifacts(registry, files.data?.files ?? [], frames, readOnly)
  const creation = useArtifactCreation({
    artifacts,
    conversationId,
    filesLoaded: files.data !== undefined,
    readOnly,
  })
  const selected = pickArtifact(registry, artifacts, artifactId)
  const entry = selected === undefined ? undefined : registry.resolve(selected.type)
  const selectedId = selected?.id
  useEffect(() => {
    const previous = previousOpenRef.current
    previousOpenRef.current = { selectedId, token: openToken }
    if (previous.token !== openToken) {
      onOpen('explicit')
    } else if (selectedId !== undefined && selectedId !== previous.selectedId && !compact) {
      onOpen('automatic')
    }
  }, [compact, onOpen, openToken, selectedId])
  useLayoutEffect(() => {
    if (!refocusTabRef.current) return
    refocusTabRef.current = false
    asideRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus()
  }, [selectedId])

  const open = (id: string | undefined) => {
    void openArtifact(id)
  }
  const closeTab = (byKeyboard: boolean) => {
    refocusTabRef.current = byKeyboard
    open(pickArtifact(registry, artifacts, undefined)?.id)
  }

  const actions = compact ? null : !sideBySide ? (
    <IconButton
      className={WORKBENCH_BUTTON_CLASS}
      label="回到对话"
      name="back"
      onClick={() => onCollapsedChange(true)}
      size="sm"
    />
  ) : (
    <>
      {chrome.onSwapPanes === undefined ? null : (
        <IconButton
          className={WORKBENCH_BUTTON_CLASS}
          label="交换对话与工作台"
          name="swap-panes"
          onClick={chrome.onSwapPanes}
          size="sm"
        />
      )}
      <IconButton
        className={WORKBENCH_BUTTON_CLASS}
        label="折叠工作台"
        name="final-cut-panel-close"
        onClick={() => onCollapsedChange(true)}
        size="sm"
      />
    </>
  )

  const rail =
    railSlot === null
      ? null
      : createPortal(
          <WorkbenchRail
            creatable={creation.creatable}
            creating={creation.creating}
            items={artifacts.flatMap((artifact) => {
              const own = registry.resolve(artifact.type)
              return own !== undefined && isStanding(own)
                ? [{ icon: own.icon, id: artifact.id, title: artifact.title }]
                : []
            })}
            onCreate={creation.create}
            onOpen={(id) => {
              requestOpen()
              open(id)
            }}
          />,
          railSlot,
        )

  const Renderer = entry?.component

  if (selected === undefined || entry === undefined || Renderer === undefined) {
    return (
      <aside aria-label="工作台" className="flex h-full min-h-0 min-w-0 flex-col bg-control-well">
        <WorkbenchBar end={actions}>
          <span className="pl-1 text-ui font-semibold text-on-surface-muted">工作台</span>
        </WorkbenchBar>
        <Chooser
          creatable={creation.creatable}
          creating={creation.creating}
          onCreate={creation.create}
          onPick={open}
          rows={chooserRows(registry, artifacts)}
        />
        {rail}
      </aside>
    )
  }

  const renderer = (
    <WorkbenchHeaderSlotContext value={headerSlot}>
      <Renderer
        artifact={selected}
        conversationId={conversationId}
        key={selected.id}
        readOnly={readOnly}
      />
    </WorkbenchHeaderSlotContext>
  )

  return (
    <aside
      aria-label="工作台"
      className="flex h-full min-h-0 min-w-0 flex-col bg-control-well"
      ref={asideRef}
    >
      <TabsRoot className="flex min-h-0 flex-1 flex-col" onValueChange={open} value={selected.id}>
        <WorkbenchBar
          end={
            <>
              <div
                className={cn(
                  'flex shrink-0 items-center gap-1.5 empty:hidden',
                  // 页签放了控件时和后面的交换、折叠之间隔一道淡出两头的细线
                  actions !== null &&
                    'after:mx-0.5 after:h-4 after:w-px after:bg-linear-to-b after:from-transparent after:via-panel-line-strong after:to-transparent',
                )}
                ref={setHeaderSlot}
              />
              {actions}
            </>
          }
        >
          <TabsList aria-label="面板内容" variant="segmented">
            {artifacts
              .filter(
                (artifact) =>
                  artifact.id === selected.id || isStandingType(registry, artifact.type),
              )
              .map((artifact) => {
                // 不常驻的（委派任务）只在被选中时占着页签，可以关
                const closable = !isStandingType(registry, artifact.type)
                return (
                  <TabsTrigger
                    aria-keyshortcuts={closable ? 'Delete' : undefined}
                    className={cn(
                      'max-w-64 gap-1.25',
                      creation.arrived(artifact.id) &&
                        'motion-safe:animate-in motion-safe:duration-(--dur-m) motion-safe:ease-(--ease-decel) motion-safe:fade-in motion-safe:zoom-in-92',
                    )}
                    key={artifact.id}
                    onKeyDown={
                      closable
                        ? (event) => {
                            if (event.key !== 'Delete') return
                            event.preventDefault()
                            closeTab(true)
                          }
                        : undefined
                    }
                    trailing={closable ? <CloseMark onClose={() => closeTab(false)} /> : null}
                    value={artifact.id}
                  >
                    {artifact.title}
                  </TabsTrigger>
                )
              })}
          </TabsList>
          {creation.creatable.length === 0 ? null : (
            <CreateMenu
              creating={creation.creating}
              entries={creation.creatable}
              onCreate={creation.create}
            />
          )}
        </WorkbenchBar>
        <TabsContent
          className={cn('flex min-h-0 flex-1 flex-col', !entry.frameless && 'px-3 pb-3')}
          value={selected.id}
        >
          {entry.frameless ? (
            renderer
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel bg-surface shadow-[var(--shadow-panel),var(--shadow-specular)]">
              {renderer}
            </div>
          )}
        </TabsContent>
      </TabsRoot>
      {rail}
    </aside>
  )
}

/**
 * 能关的页签名字后面的 ×：只给鼠标点，读屏和键盘走页签上的 Delete 键（WAI-ARIA 页签模式的做法），
 * 所以不进无障碍树、不单独占焦点。页签按下鼠标就会选中，这里拦住不让它冒上去。
 */
function CloseMark({ onClose }: { onClose: () => void }) {
  return (
    <span
      aria-hidden
      className="-mr-1 grid size-3.75 shrink-0 place-items-center rounded-xs text-on-surface-faint hover:bg-state-hover hover:text-on-surface"
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Icon decorative name="close" size="xs" />
    </span>
  )
}
