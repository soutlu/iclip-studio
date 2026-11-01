import { useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { cn } from '@/shared/lib/utils'
import { useShellChrome } from '@/shared/shell'
import { Button } from '@/shared/ui/button'
import { ListEmpty, ListError, ListPending } from '@/shared/ui/list-state'
import { TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import type { DraftValue } from '../agent-draft'
import { useAgent, useAgents, useAgentVersions } from '../agents.api'
import { CreateAgentPage } from './agent-definition-form'
import { AgentWorkspace } from './agent-workspace'
import type { Panel } from './panel'
import { PreviewHost, type PreviewConversationProps } from './preview-host'

type AgentConfigPageProps = {
  /** 地址栏里选中的 agent；不给或不存在时选第一个在用的。 */
  agentId: string | undefined
  onAgentChange: (id: string) => void
  /** 右栏测试预览里的对话与运行过程；对话组件属于对话模块，由路由层接进来。 */
  PreviewConversation: ComponentType<PreviewConversationProps>
}

/** 按 agent 记的界面状态：换了 agent 就各自从头（不开面板、看草稿）。 */
type Scoped<T> = { agentId: string | null; value: T }

/**
 * Agent 配置页：顶部是配置导航（这一版有「Agent」「技能库」「插件」「MCP 服务」，持 `model:manage` 时另有「模型与供应商」）
 * 与「新建 Agent」，下面左右各半，左边编辑 agent，右边默认是测试预览，打开配置面板时面板替换它（预览留着，只是看不见）；
 * 不开弹窗。
 */
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
  // 面板收起后把焦点还给打开它的那个控件。
  const openerRef = useRef<HTMLElement | null>(null)

  const list = agents.data ?? []
  const currentId =
    list.find((agent) => agent.id === agentId)?.id ??
    list.find((agent) => agent.status === 'active')?.id ??
    null
  const panel = panelState.agentId === currentId ? panelState.value : null
  const viewingVersionId = versionState.agentId === currentId ? versionState.value : null
  // 编辑区与版本菜单读的是同一份，这里不另起请求。
  const currentDetail = useAgent(currentId)
  const versions = useAgentVersions(currentId)
  const viewingVersionNumber = versions.data?.find((item) => item.id === viewingVersionId)?.version

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

  const tab =
    creating || panel === null
      ? 'agent'
      : panel.type === 'plugins' || panel.type === 'skills' || panel.type === 'providers'
        ? panel.type
        : panel.type.startsWith('mcp-')
          ? 'mcp'
          : 'agent'
  // 编辑技能时正文通常很长：右栏从一半加宽到 3/5，左栏照常可用，一页里改完。
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
              // 编辑器、选技能也算在这一页下面：已选中时再点回到技能库（Radix 对已选中的页签不发 onValueChange）。
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
              // 在管理列表或某个服务的配置里时这一项已经选中，再点回到服务库。
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

      <div
        className={cn(
          // relative：测试预览（PreviewHost）绝对定位在右半栏。
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
