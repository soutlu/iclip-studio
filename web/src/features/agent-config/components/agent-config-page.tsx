import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { useShellChrome } from '@/shared/shell'
import { Button } from '@/shared/ui/button'
import { ListEmpty, ListError, ListPending } from '@/shared/ui/list-state'
import { TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import type { DraftValue } from '../agent-draft'
import { useAgents } from '../agents.api'
import { CreateAgentPage } from './agent-definition-form'
import { AgentWorkspace } from './agent-workspace'
import type { Panel } from './panel'

type AgentConfigPageProps = {
  /** 地址栏里选中的 agent；不给或不存在时选第一个在用的。 */
  agentId: string | undefined
  onAgentChange: (id: string) => void
}

/** 按 agent 记的界面状态：换了 agent 就各自从头（不开面板、看草稿）。 */
type Scoped<T> = { agentId: string | null; value: T }

/**
 * Agent 配置页：顶部是配置导航（这一版有「Agent」「插件」）与「新建 Agent」，下面左右各半，
 * 左边编辑 agent，右边是打开的配置面板；不开弹窗，细节编辑都替换右栏。
 */
export function AgentConfigPage({ agentId, onAgentChange }: AgentConfigPageProps) {
  const agents = useAgents()
  const { sidebarOverlay } = useShellChrome()
  const [creating, setCreating] = useState(false)
  const [edits, setEdits] = useState<Record<string, DraftValue>>({})
  const [panelState, setPanelState] = useState<Scoped<Panel | null>>({ agentId: null, value: null })
  const [versionState, setVersionState] = useState<Scoped<string | null>>({
    agentId: null,
    value: null,
  })
  // 面板收起后把焦点还给打开它的那个控件。
  const openerRef = useRef<HTMLElement | null>(null)

  const list = agents.data ?? []
  const currentId =
    list.find((agent) => agent.id === agentId)?.id ??
    list.find((agent) => agent.status === 'active')?.id ??
    null
  const panel = panelState.agentId === currentId ? panelState.value : null
  const viewingVersionId = versionState.agentId === currentId ? versionState.value : null

  const setPanel = (next: Panel | null) => {
    if (next !== null && panel === null && document.activeElement instanceof HTMLElement)
      openerRef.current = document.activeElement
    // 打开面板就回到草稿：面板改的是草稿。
    if (next !== null) setVersionState({ agentId: currentId, value: null })
    setPanelState({ agentId: currentId, value: next })
  }

  useLayoutEffect(() => {
    if (panel !== null) return
    const opener = openerRef.current
    openerRef.current = null
    if (opener?.isConnected === true) opener.focus({ preventScroll: true })
  }, [panel])

  const createRef = useRef<HTMLButtonElement>(null)
  const selectAgent = (id: string) => {
    setCreating(false)
    onAgentChange(id)
  }
  // 取消新建回到原来的编辑区，焦点回到「新建 Agent」。
  const cancelCreating = () => {
    setCreating(false)
    requestAnimationFrame(() => createRef.current?.focus({ preventScroll: true }))
  }

  const tab = !creating && panel?.type === 'plugins' ? 'plugins' : 'agent'

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
            else if (creating) cancelCreating()
            else setPanel(null)
          }}
          value={tab}
        >
          <TabsList aria-label="配置管理">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger disabled={creating || currentId === null} value="plugins">
              插件
            </TabsTrigger>
          </TabsList>
        </TabsRoot>
        <Button
          className="self-center"
          disabled={creating}
          leadingIcon="add"
          onClick={() => setCreating(true)}
          ref={createRef}
          size="md"
          variant="ghost"
        >
          新建 Agent
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
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
          <div className="col-span-full">
            <ListEmpty>暂无 Agent，请点击「新建 Agent」创建</ListEmpty>
          </div>
        ) : (
          <AgentWorkspace
            agentId={currentId}
            agents={list}
            edit={edits[currentId]}
            key={currentId}
            onEditChange={(edit) =>
              setEdits(({ [currentId]: _previous, ...rest }) =>
                edit === undefined ? rest : { ...rest, [currentId]: edit },
              )
            }
            onPanelChange={setPanel}
            onSelectAgent={selectAgent}
            onViewVersion={(value) => {
              setVersionState({ agentId: currentId, value })
              // 看历史版本时右栏的草稿面板收起。
              if (value !== null) setPanelState({ agentId: currentId, value: null })
            }}
            panel={panel}
            viewingVersionId={viewingVersionId}
          />
        )}
      </div>
    </main>
  )
}
