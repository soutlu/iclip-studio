/** 宿主负责产物选择与渲染；可见性、宽度和聚焦布局由应用壳控制。 */

import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect, useMemo, useRef } from 'react'
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
import { useWorkbenchRegistry } from './use-workbench-registry'
import { useWorkbenchOpenRequest } from './use-workbench-open-request'
import { WorkbenchLayoutContext } from './workbench-layout-context'
import { useWorkspaceFiles, workspaceQueryKeys } from './workspace.api'

/** 主流里的每张工具卡都是候选产物，命不命中由注册表定；view 缺省按协议算 generic。 */
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

/** 常驻类型与被点开的那张工具卡才占标签位；没点开的派活卡留在选择页里，或从卡上「查看」进来。 */
const tabArtifacts = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  selected: Artifact,
): Artifact[] =>
  artifacts.filter((artifact) => {
    const entry = registry.resolve(artifact.type)
    return (entry !== undefined && isStanding(entry)) || artifact.id === selected.id
  })

type ChooserRow = {
  key: string
  label: string
  icon: ArtifactEntry['icon']
  /** 有产物就能打开；常驻类型还没有产物时灰着，detail 说明为什么。 */
  artifactId?: string
  detail?: string
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

/** 常驻类型按登记顺序，每件产物一行，没有产物且登记了原因的列一行灰的；工具卡产物一件一行。 */
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
  // 与聊天页共用主会话池里的同一份流（按对话记持有数），这里再用不会踢掉它的订阅。
  const { view } = useTranscript(conversationId)
  const readOnly = useConversationReadOnly(view)
  const frames = useMemo(() => toolFrames(view.items), [view.items])
  const { openToken } = useWorkbenchOpenRequest()
  const layout = use(WorkbenchLayoutContext)
  if (layout === null) throw new Error('WorkbenchHost 要在 WorkbenchLayoutProvider 里用')
  const { compact, onCollapsedChange, onOpen, sideBySide } = layout
  const previousOpenRef = useRef<{ selectedId: string | undefined; token: number }>({
    selectedId: undefined,
    token: openToken,
  })

  // 重连后重拉文件，补偿断线期间通知丢失（contract/conventions.md §5）。
  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchSessions((update) => {
      if (update.kind !== 'reconnected') return
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all(conversationId) })
    })
  }, [connection, conversationId, queryClient])

  // 订整个工作区：任何文件变了，列表与那个文件的查询一起失效。分镜标签在 video_shot.json 落地那一刻出现。
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

  const artifacts = composeArtifacts(registry, files.data?.files ?? [], frames)
  // 地址点名的或 autoOpen 的那件才算选中；都没有就给选择页，不替用户挑第一件。
  const selected = pickArtifact(registry, artifacts, artifactId)
  const entry = selected === undefined ? undefined : registry.resolve(selected.type)
  const selectedId = selected?.id
  // 只响应新的产物选择或显式「查看」请求；壳隐藏工作台时保留渲染器，不重新自动展开。
  useEffect(() => {
    const previous = previousOpenRef.current
    previousOpenRef.current = { selectedId, token: openToken }
    if (previous.token !== openToken) {
      onOpen('explicit')
    } else if (selectedId !== undefined && selectedId !== previous.selectedId && !compact) {
      onOpen('automatic')
    }
  }, [compact, onOpen, openToken, selectedId])

  const open = (id: string) => {
    void openArtifact(id)
  }

  const actions = compact ? null : (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1',
        sideBySide &&
          'opacity-0 group-focus-within/pane-header:opacity-100 group-hover/pane-header:opacity-100',
      )}
    >
      {!sideBySide ? (
        <IconButton
          label="回到对话"
          name="back"
          onClick={() => onCollapsedChange(true)}
          size="md"
        />
      ) : (
        <>
          {chrome.onSwapPanes === undefined ? null : (
            <IconButton
              label="交换对话与工作台"
              name="swap-panes"
              onClick={chrome.onSwapPanes}
              size="sm"
            />
          )}
          <IconButton
            label="折叠工作台"
            name="panel-right"
            onClick={() => onCollapsedChange(true)}
            size="sm"
          />
        </>
      )}
    </div>
  )

  const Renderer = entry?.component

  return (
    <aside aria-label="工作台" className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {selected === undefined || Renderer === undefined ? (
        <>
          <div
            className={cn(
              'group/pane-header flex h-13 shrink-0 items-center justify-end pr-2',
              chrome.sidebarOverlay && 'pr-14 pl-14',
            )}
            data-pane-drag-handle
          >
            {actions}
          </div>
          <Chooser onPick={open} rows={chooserRows(registry, artifacts)} />
        </>
      ) : (
        <TabsRoot className="flex min-h-0 flex-1 flex-col" onValueChange={open} value={selected.id}>
          <div
            className={cn(
              'group/pane-header flex h-13 shrink-0 items-stretch gap-2 border-b-[0.5px] border-chat-hairline pr-2 pl-3',
              chrome.sidebarOverlay && 'pr-14 pl-14',
            )}
            data-pane-drag-handle
          >
            <TabsList aria-label="面板内容" className="min-w-0 flex-1">
              {tabArtifacts(registry, artifacts, selected).map((artifact) => (
                <TabsTrigger className="max-w-64" key={artifact.id} value={artifact.id}>
                  {artifact.title}
                </TabsTrigger>
              ))}
            </TabsList>
            {actions}
          </div>
          <TabsContent className="flex min-h-0 flex-1 flex-col" value={selected.id}>
            <Renderer
              artifact={selected}
              conversationId={conversationId}
              key={selected.id}
              readOnly={readOnly}
            />
          </TabsContent>
        </TabsRoot>
      )}
    </aside>
  )
}

/** 选择页：正文居中一列，能打开的项一行一个；没有产物的常驻类型灰着，行尾说明为什么。 */
function Chooser({ onPick, rows }: { onPick: (id: string) => void; rows: readonly ChooserRow[] }) {
  return (
    <nav
      aria-label="能打开的产物"
      className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-8 py-6"
    >
      <ul className="mx-auto flex w-full max-w-md flex-col gap-1">
        {rows.map((row) => {
          const enabled = row.artifactId !== undefined
          return (
            <li key={row.key}>
              <button
                aria-disabled={enabled ? undefined : true}
                className={cn(
                  'flex h-11 w-full items-center gap-3 rounded-sm px-3 text-left text-body ui-focus',
                  enabled
                    ? 'ui-state cursor-pointer text-on-surface'
                    : 'cursor-default text-on-surface-faint',
                )}
                onClick={() => {
                  if (row.artifactId !== undefined) onPick(row.artifactId)
                }}
                type="button"
              >
                <Icon
                  className={cn(
                    'shrink-0',
                    enabled ? 'text-on-surface-variant' : 'text-on-surface-faint',
                  )}
                  decorative
                  name={row.icon}
                  size="md"
                />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.detail === undefined ? null : (
                  <span className="shrink-0 rounded-full bg-chip-bg px-2 py-0.5 text-label text-on-surface-faint">
                    {row.detail}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
