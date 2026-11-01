import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { toast } from '@/shared/ui/toast'
import { sameDraft, sectionOfProblem, type DraftValue } from '../agent-draft'
import {
  agentQueryKeys,
  isStaleDraft,
  publishProblemsOf,
  useAgent,
  useAgentPlugins,
  useAgentVersion,
  useAgentVersions,
  useModelOptions,
  usePublishAgent,
  useRestoreVersion,
  useSaveDraft,
  useSkills,
  type Agent,
  type AgentConfig,
  type AgentDetail,
  type AgentProblem,
} from '../agents.api'
import { AgentDefinitionPanel } from './agent-definition-form'
import { AgentEditorPane, type SectionProblems } from './agent-editor-pane'
import { AgentHeader } from './agent-header'
import { ModelPanel } from './model-panel'
import type { Panel } from './panel'
import { PluginPanel } from './plugin-panel'
import { PromptPanel } from './prompt-panel'
import { SubagentPanel } from './subagent-panel'

const STALE_NOTICE = '草稿已被别人修改，已读取最新的草稿；刚才没保存的修改已丢弃，请重新修改后保存'

const draftOf = (detail: AgentDetail): DraftValue => ({
  config: detail.draft.config,
  skillIds: detail.draft.skillIds,
})

type AgentWorkspaceProps = {
  agentId: string
  agents: readonly Agent[]
  onSelectAgent: (id: string) => void
  /** 这个 agent 还没保存的修改；没有为 undefined。由页面按 agent 保管，切走再切回来还在。 */
  edit: DraftValue | undefined
  onEditChange: (edit: DraftValue | undefined) => void
  panel: Panel | null
  onPanelChange: (panel: Panel | null) => void
  viewingVersionId: string | null
  onViewVersion: (versionId: string | null) => void
}

/**
 * 一个 agent 的编辑区：左栏是配置摘要与保存、发布，右栏是打开的配置面板。
 * 编辑的是服务端草稿的一份拷贝；保存整份覆盖并带读到的 lockVersion，发布前先把没保存的修改存上。
 */
export function AgentWorkspace({
  agentId,
  agents,
  edit,
  onEditChange,
  onPanelChange,
  onSelectAgent,
  onViewVersion,
  panel,
  viewingVersionId,
}: AgentWorkspaceProps) {
  const queryClient = useQueryClient()
  const detail = useAgent(agentId)
  const versions = useAgentVersions(agentId)
  const viewed = useAgentVersion(agentId, viewingVersionId)
  const plugins = useAgentPlugins()
  const modelOptions = useModelOptions()
  const skills = useSkills()
  const saveDraft = useSaveDraft()
  const publish = usePublishAgent()
  const restore = useRestoreVersion()
  const [problems, setProblems] = useState<AgentProblem[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  if (detail.isPending || detail.isError)
    return (
      <div className="col-span-full">
        {detail.isPending ? (
          <ListPending label="正在读取 Agent…" />
        ) : (
          <ListError message={detail.error.message} onRetry={() => void detail.refetch()} />
        )}
      </div>
    )

  const agent = detail.data
  const server = draftOf(agent)
  const draft = edit ?? server
  const dirty = !sameDraft(draft, server)
  const unpublished = dirty || agent.hasUnpublishedChanges
  const busy = saveDraft.isPending || publish.isPending || restore.isPending
  const viewingVersion = viewingVersionId !== null
  const shown: DraftValue | undefined = viewingVersion ? viewed.data : draft

  const changeConfig = (config: AgentConfig) => {
    onEditChange({ ...draft, config })
    setProblems([])
    setNotice(null)
  }

  const fail = (error: unknown, fallback: string) => {
    if (isStaleDraft(error)) {
      onEditChange(undefined)
      void queryClient.invalidateQueries({ queryKey: agentQueryKeys.detail(agentId) })
      setNotice(STALE_NOTICE)
      return
    }
    setNotice(errorMessageOf(error, fallback))
  }

  /** 存上没保存的修改，交回存好后的详情（下一步发布要用它的 lockVersion）；失败交回 null。 */
  const save = async (): Promise<AgentDetail | null> => {
    setNotice(null)
    try {
      const saved = await saveDraft.mutateAsync({
        draft: { ...draft, lockVersion: agent.draft.lockVersion },
        id: agentId,
      })
      onEditChange(undefined)
      return saved
    } catch (error) {
      fail(error, '草稿保存失败，请重试保存')
      return null
    }
  }

  const onSave = async () => {
    if ((await save()) !== null) toast.success('草稿已保存')
  }

  const onPublish = async () => {
    setNotice(null)
    let lockVersion = agent.draft.lockVersion
    if (dirty) {
      const saved = await save()
      if (saved === null) return
      lockVersion = saved.draft.lockVersion
    }
    try {
      const created = await publish.mutateAsync({ id: agentId, lockVersion })
      setProblems([])
      toast.success(`已发布 v${created.version}`)
    } catch (error) {
      const found = publishProblemsOf(error)
      if (found === null) fail(error, '发布失败，请重试发布')
      else setProblems(found)
    }
  }

  const onRestore = async () => {
    const version = versions.data?.find((item) => item.id === viewingVersionId)
    if (viewingVersionId === null) return
    setNotice(null)
    try {
      await restore.mutateAsync({
        id: agentId,
        lockVersion: agent.draft.lockVersion,
        versionId: viewingVersionId,
      })
      onEditChange(undefined)
      setProblems([])
      onViewVersion(null)
      toast.success(version === undefined ? '已恢复到草稿' : `已把 v${version.version} 恢复到草稿`)
    } catch (error) {
      fail(error, '恢复失败，请重试恢复')
    }
  }

  const grouped: SectionProblems = {}
  for (const problem of problems) {
    const section = sectionOfProblem(problem, draft.config)
    grouped[section] = [...(grouped[section] ?? []), problem.message]
  }

  const closePanel = () => onPanelChange(null)
  const current = { id: agent.id, isSubagent: agent.isSubagent }

  return (
    <>
      <section
        aria-label="Agent 配置编辑器"
        className={cn(
          'flex min-h-0 min-w-0 flex-col border-hairline md:border-r',
          panel !== null && 'max-md:hidden',
        )}
      >
        <header className="flex h-15 shrink-0 items-center gap-2 border-b border-hairline pr-4 pl-5">
          <AgentHeader
            agents={agents}
            current={{
              activeVersionId: agent.activeVersion?.id ?? null,
              id: agent.id,
              name: agent.name,
            }}
            definitionOpen={panel?.type === 'definition'}
            onEditDefinition={() =>
              onPanelChange(panel?.type === 'definition' ? null : { type: 'definition' })
            }
            onSelectAgent={onSelectAgent}
            onViewVersion={(versionId) => {
              onViewVersion(versionId)
              setNotice(null)
            }}
            unpublished={unpublished}
            versions={versions.data}
            viewingVersionId={viewingVersionId}
          />
        </header>
        {shown === undefined ? (
          viewed.isError ? (
            <ListError message={viewed.error.message} onRetry={() => void viewed.refetch()} />
          ) : (
            <ListPending label="正在读取版本…" />
          )
        ) : (
          <AgentEditorPane
            agents={agents}
            current={current}
            onOpenPanel={onPanelChange}
            panel={panel}
            plugins={plugins.data ?? []}
            problems={viewingVersion ? {} : grouped}
            readOnly={viewingVersion}
            skills={skills.data ?? []}
            value={shown}
          />
        )}
        <footer className="flex h-16 shrink-0 items-center justify-end gap-2 border-t border-hairline px-6">
          {notice === null ? null : (
            <p className="mr-auto min-w-0 text-body-sm text-error" role="alert">
              {notice}
            </p>
          )}
          {viewingVersion ? (
            <>
              <Button disabled={busy} onClick={() => onViewVersion(null)} size="md" variant="ghost">
                返回草稿
              </Button>
              <Button
                disabled={shown === undefined}
                leadingIcon="restore"
                loading={restore.isPending}
                onClick={() => void onRestore()}
                size="md"
              >
                恢复到草稿
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={!dirty || busy}
                loading={saveDraft.isPending && !publish.isPending}
                onClick={() => void onSave()}
                size="md"
                variant="ghost"
              >
                保存草稿
              </Button>
              <Button
                disabled={!unpublished || busy}
                loading={publish.isPending}
                onClick={() => void onPublish()}
                size="md"
              >
                发布
              </Button>
            </>
          )}
        </footer>
      </section>

      <section
        aria-label={panel === null ? 'Agent 预览' : '配置调整'}
        className={cn('flex min-h-0 min-w-0 flex-col', panel === null && 'max-md:hidden')}
      >
        {panel === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-on-surface-variant">
            <span
              aria-hidden
              className="grid size-10 place-items-center rounded-md bg-surface-container-high"
            >
              <Icon decorative name="agent" size="lg" />
            </span>
            <p className="max-w-full truncate text-title font-semibold text-on-surface">
              {agent.name}
            </p>
          </div>
        ) : panel.type === 'prompt' ? (
          <PromptPanel
            onChange={(instructions) => changeConfig({ ...draft.config, instructions })}
            onClose={closePanel}
            value={draft.config.instructions ?? ''}
          />
        ) : panel.type === 'model' ? (
          <ModelPanel
            config={draft.config}
            onChange={changeConfig}
            onClose={closePanel}
            providers={modelOptions.data ?? []}
          />
        ) : panel.type === 'plugins' ? (
          <PluginPanel
            config={draft.config}
            onChange={changeConfig}
            onClose={closePanel}
            plugins={plugins.data ?? []}
          />
        ) : panel.type === 'subagents' ? (
          <SubagentPanel
            agents={agents}
            config={draft.config}
            current={current}
            focus={panel.focus}
            key={panel.focus ?? ''}
            onChange={changeConfig}
            onClose={closePanel}
          />
        ) : (
          <AgentDefinitionPanel agent={agent} key={agent.updatedAt} onClose={closePanel} />
        )}
      </section>
    </>
  )
}
