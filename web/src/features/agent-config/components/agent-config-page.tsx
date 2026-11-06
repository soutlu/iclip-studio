import { useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { cn } from '@/shared/lib/utils'
import { useShellChrome } from '@/shared/shell'
import { Button } from '@/shared/ui/button'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import type { DraftValue } from '../agent-draft'
import { useAgent, useAgents, useAgentVersions } from '../agents.api'
import { CreateAgentPage } from './agent-definition-form'
import { AgentWorkspace } from './agent-workspace'
import type { Panel } from './panel'
import { PreviewHost, type PreviewConversationProps } from './preview-host'

type AgentConfigPageProps = {
  agentId: string | undefined
  onAgentChange: (id: string) => void
  PreviewConversation: ComponentType<PreviewConversationProps>
}

type Scoped<T> = { agentId: string | null; value: T }

export function AgentConfigPage({
  agentId,
  onAgentChange,
  PreviewConversation,
}: AgentConfigPageProps) {
  const agents = useAgents()
  const canManageModels = hasPermission(useUser().data, PERMISSION.modelManage)
  const { sidebarOverlay } = useShellChrome()
  const [creating, setCreating] = useState(false)
  const [edits, setEdits] = useState<Record<string, DraftValue>>({})
  const [panelState, setPanelState] = useState<Scoped<Panel | null>>({ agentId: null, value: null })
  const [versionState, setVersionState] = useState<Scoped<string | null>>({
    agentId: null,
    value: null,
  })
  const openerRef = useRef<HTMLElement | null>(null)

  const list = agents.data ?? []
  const currentId =
    list.find((agent) => agent.id === agentId)?.id ??
    list.find((agent) => agent.status === 'active')?.id ??
    null
  const panel = panelState.agentId === currentId ? panelState.value : null
  const viewingVersionId = versionState.agentId === currentId ? versionState.value : null
  const currentDetail = useAgent(currentId)
  const versions = useAgentVersions(currentId)
  const viewingVersionNumber = versions.data?.find((item) => item.id === viewingVersionId)?.version

  const setPanel = (next: Panel | null) => {
    if (next !== null && panel === null && document.activeElement instanceof HTMLElement)
      openerRef.current = document.activeElement
    if (next !== null) setVersionState({ agentId: currentId, value: null })
    setPanelState({ agentId: currentId, value: next })
  }

  useLayoutEffect(() => {
    if (panel !== null) return
    const opener = openerRef.current
    openerRef.current = null
    if (opener?.isConnected === true) opener.focus({ preventScroll: true })
  }, [panel])

  const agentEntryRef = useRef<HTMLButtonElement>(null)
  const selectAgent = (id: string) => {
    setCreating(false)
    onAgentChange(id)
  }
  const cancelCreating = () => {
    setCreating(false)
    requestAnimationFrame(() => agentEntryRef.current?.focus({ preventScroll: true }))
  }

  const tab =
    creating || panel === null
      ? 'agent'
      : panel.type === 'plugins' || panel.type === 'skills' || panel.type === 'providers'
        ? panel.type
        : panel.type.startsWith('mcp-')
          ? 'mcp'
          : 'agent'
  const wideRight = panel?.type === 'skills' && panel.view.kind === 'editor'

  return (
    <main aria-label="Agent 配置" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div
        className={cn(
          'flex h-12 shrink-0 items-stretch gap-1 border-b border-hairline pr-4 pl-5',
          sidebarOverlay && 'pl-14',
        )}
      >
        <TabsRoot
          className="flex min-w-0 flex-1"
          onValueChange={(value) => {
            if (value === 'plugins') setPanel({ type: 'plugins' })
            else if (value === 'skills') setPanel({ type: 'skills', view: { kind: 'library' } })
            else if (value === 'mcp') setPanel({ type: 'mcp-library' })
            else if (value === 'providers') setPanel({ type: 'providers' })
            else if (creating) cancelCreating()
            else setPanel(null)
          }}
          value={tab}
        >
          <TabsList aria-label="配置管理">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger
              disabled={creating || currentId === null}
              onClick={() => {
                if (tab === 'skills') setPanel({ type: 'skills', view: { kind: 'library' } })
              }}
              value="skills"
            >
              技能库
            </TabsTrigger>
            <TabsTrigger disabled={creating || currentId === null} value="plugins">
              插件
            </TabsTrigger>
            <TabsTrigger
              disabled={creating || currentId === null}
              onClick={() => {
                if (panel?.type !== 'mcp-library') setPanel({ type: 'mcp-library' })
              }}
              value="mcp"
            >
              MCP 服务
            </TabsTrigger>
            {canManageModels ? (
              <TabsTrigger disabled={creating || currentId === null} value="providers">
                模型与供应商
              </TabsTrigger>
            ) : null}
          </TabsList>
        </TabsRoot>
      </div>

      <div
        className={cn(
          'relative grid min-h-0 flex-1 grid-cols-1 transition-[grid-template-columns] ui-motion-m motion-reduce:transition-none',
          wideRight
            ? 'md:grid-cols-[minmax(420px,2fr)_minmax(0,3fr)]'
            : 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]',
        )}
      >
        {creating ? (
          <CreateAgentPage onCancel={cancelCreating} onCreated={selectAgent} />
        ) : agents.isPending ? (
          <div className="col-span-full">
            <ListPending label="正在读取 Agent…" />
          </div>
        ) : agents.isError ? (
          <div className="col-span-full">
            <ListError message={agents.error.message} onRetry={() => void agents.refetch()} />
          </div>
        ) : currentId === null ? (
          <div className="col-span-full flex flex-col items-center justify-center gap-4 px-6 py-16">
            <p className="text-body text-on-surface-variant">
              暂无 Agent，请点击「新建 Agent」创建
            </p>
            <Button
              leadingIcon="add"
              onClick={() => setCreating(true)}
              ref={agentEntryRef}
              size="md"
              variant="outlined"
            >
              新建 Agent
            </Button>
          </div>
        ) : (
          <AgentWorkspace
            agentEntryRef={agentEntryRef}
            agentId={currentId}
            agents={list}
            edit={edits[currentId]}
            key={currentId}
            onCreateAgent={() => setCreating(true)}
            onEditChange={(edit) =>
              setEdits(({ [currentId]: _previous, ...rest }) =>
                edit === undefined ? rest : { ...rest, [currentId]: edit },
              )
            }
            onPanelChange={setPanel}
            onSelectAgent={selectAgent}
            onViewVersion={(value) => {
              setVersionState({ agentId: currentId, value })
              if (value !== null) setPanelState({ agentId: currentId, value: null })
            }}
            panel={panel}
            viewingVersionId={viewingVersionId}
          />
        )}
        {currentId === null ? null : (
          <PreviewHost
            agentId={currentId}
            hidden={creating || panel !== null || !currentDetail.isSuccess}
            Conversation={PreviewConversation}
            versionId={viewingVersionId}
            versionNumber={viewingVersionNumber}
          />
        )}
      </div>
    </main>
  )
}
