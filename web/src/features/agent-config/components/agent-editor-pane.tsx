import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { Markdown } from '@/shared/ui/markdown'
import { thinkingLabel } from '@/shared/ui/thinking-level'
import {
  enabledPluginNames,
  missingRequiresReason,
  subagentBlockReason,
  type DraftValue,
  type EditorSection,
} from '../agent-draft'
import type { Agent, AgentPlugin, Skill } from '../agents.api'
import { pluginIcon } from '../plugin-icons'
import { skillIcon } from '../skill-icons'
import { McpCards } from './mcp-cards'
import type { Panel } from './panel'
import {
  AddCard,
  AlertGlyph,
  CardBadge,
  DIRECTORY_GRID,
  DirectoryCard,
  EmptyDash,
} from './resource-card'

export type SectionProblems = Partial<Record<EditorSection, string[]>>

function Section({
  actions,
  children,
  problems,
  section,
  title,
}: {
  section: EditorSection
  title: string
  actions?: ReactNode
  problems: string[] | undefined
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="scroll-mt-4" data-section={section}>
      <div className="mb-2.5 flex min-h-8 items-center justify-between gap-3">
        <h2 className="flex shrink-0 items-center gap-1.5 text-body font-semibold text-on-surface">
          {title}
          {problems === undefined ? null : (
            <Icon className="text-error" decorative name="alert" size="sm" />
          )}
        </h2>
        {actions === undefined ? null : (
          <div className="-mr-1 flex min-w-0 items-center gap-1">{actions}</div>
        )}
      </div>
      {problems === undefined ? null : <ProblemList problems={problems} />}
      {children}
    </section>
  )
}

function ProblemList({ problems }: { problems: string[] }) {
  return (
    <ul className="mb-3 flex flex-col gap-1 text-body-sm text-error" role="alert">
      {problems.map((message) => (
        <li className="flex items-start gap-1.5" key={message}>
          <Icon className="mt-0.5 shrink-0" decorative name="alert" size="sm" />
          {message}
        </li>
      ))}
    </ul>
  )
}

type AgentEditorPaneProps = {
  value: DraftValue
  readOnly: boolean
  current: { id: string; isSubagent: boolean }
  agents: readonly Agent[]
  plugins: readonly AgentPlugin[]
  skills: readonly Skill[]
  problems: SectionProblems
  panel: Panel | null
  onOpenPanel: (panel: Panel) => void
}

export function AgentEditorPane({
  agents,
  current,
  onOpenPanel,
  panel,
  plugins,
  problems,
  readOnly,
  skills,
  value,
}: AgentEditorPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { config } = value
  const model = config.model ?? null
  const thinking = model?.settings?.thinking ?? null
  const enabled = enabledPluginNames(config)
  const subagents = config.subagents ?? []
  const addSubagentBlocked = current.isSubagent
    ? '当前 Agent 正被用作子 Agent，不能再添加子 Agent'
    : undefined
  const open = (next: Panel) => (readOnly ? undefined : () => onOpenPanel(next))

  const firstProblem = (
    ['general', 'instructions', 'skills', 'plugins', 'mcp', 'subagents'] as const
  ).find((section) => problems[section] !== undefined)
  useEffect(() => {
    if (firstProblem === undefined) return
    ref.current
      ?.querySelector(`[data-section="${firstProblem}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [firstProblem, problems])

  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-8" ref={ref}>
      <div className="flex min-w-0 flex-col gap-7">
        {problems.general === undefined ? null : (
          <div className="scroll-mt-4" data-section="general">
            <ProblemList problems={problems.general} />
          </div>
        )}

        <Section
          actions={
            readOnly ? (
              <ModelPill model={model?.name ?? null} thinking={thinking} />
            ) : (
              <ModelPill
                active={panel?.type === 'model'}
                model={model?.name ?? null}
                onClick={() => onOpenPanel({ type: 'model' })}
                thinking={thinking}
              />
            )
          }
          problems={problems.instructions}
          section="instructions"
          title="指令"
        >
          <PromptCard
            active={panel?.type === 'prompt'}
            markdown={config.instructions ?? ''}
            onOpen={open({ type: 'prompt' })}
          />
        </Section>

        <Section
          actions={
            readOnly ? undefined : (
              <IconButton
                label="添加技能"
                name="manage"
                onClick={() => onOpenPanel({ type: 'skills', view: { kind: 'catalog' } })}
                size="sm"
              />
            )
          }
          problems={problems.skills}
          section="skills"
          title="技能"
        >
          {value.skillIds.length === 0 ? (
            readOnly ? (
              <EmptyDash />
            ) : (
              <div className={DIRECTORY_GRID}>
                <AddCard
                  label="添加技能"
                  onClick={() => onOpenPanel({ type: 'skills', view: { kind: 'catalog' } })}
                />
              </div>
            )
          ) : (
            <div className={DIRECTORY_GRID}>
              {value.skillIds.map((id) => {
                const skill = skills.find((item) => item.id === id)
                const name = skill?.displayName ?? id
                return (
                  <DirectoryCard
                    active={
                      panel?.type === 'skills' &&
                      panel.view.kind === 'editor' &&
                      panel.view.skillId === id
                    }
                    badges={
                      skill?.latestVersion === null || skill === undefined ? undefined : (
                        <CardBadge>v{skill.latestVersion}</CardBadge>
                      )
                    }
                    description={skill?.description}
                    icon={skillIcon(skill?.name)}
                    key={id}
                    label={`编辑技能：${name}`}
                    name={name}
                    onOpen={open({
                      type: 'skills',
                      view: { back: null, kind: 'editor', skillId: id },
                    })}
                    tip={skill === undefined ? name : `${name}\n${skill.description}`}
                  />
                )
              })}
            </div>
          )}
        </Section>

        <Section
          actions={
            readOnly ? undefined : (
              <IconButton
                label="管理插件"
                name="manage"
                onClick={() => onOpenPanel({ type: 'plugins' })}
                size="sm"
              />
            )
          }
          problems={problems.plugins}
          section="plugins"
          title="插件"
        >
          {enabled.length === 0 ? (
            readOnly ? (
              <EmptyDash />
            ) : (
              <div className={DIRECTORY_GRID}>
                <AddCard label="启用插件" onClick={() => onOpenPanel({ type: 'plugins' })} />
              </div>
            )
          ) : (
            <div className={DIRECTORY_GRID}>
              {enabled.map((name) => {
                const plugin = plugins.find((item) => item.name === name)
                const label = plugin?.label ?? name
                const missing =
                  plugin === undefined ? undefined : missingRequiresReason(plugin, enabled, plugins)
                return (
                  <DirectoryCard
                    description={plugin?.description}
                    icon={pluginIcon(name)}
                    key={name}
                    name={label}
                    tip={plugin === undefined ? label : `${label}\n${plugin.description}`}
                    trailing={missing === undefined ? undefined : <AlertGlyph reason={missing} />}
                  />
                )
              })}
            </div>
          )}
        </Section>

        <Section
          actions={
            readOnly ? undefined : (
              <IconButton
                label="管理 MCP 服务"
                name="manage"
                onClick={() => onOpenPanel({ type: 'mcp-select' })}
                size="sm"
              />
            )
          }
          problems={problems.mcp}
          section="mcp"
          title="MCP 服务"
        >
          <McpCards config={config} onOpenPanel={onOpenPanel} panel={panel} readOnly={readOnly} />
        </Section>

        <Section
          actions={
            readOnly ? undefined : (
              <IconButton
                disabled={addSubagentBlocked !== undefined}
                label="添加子 Agent"
                name="manage"
                onClick={() => onOpenPanel({ focus: undefined, type: 'subagents' })}
                size="sm"
                tooltip={addSubagentBlocked}
              />
            )
          }
          problems={problems.subagents}
          section="subagents"
          title="子 Agent"
        >
          {subagents.length === 0 ? (
            readOnly ? (
              <EmptyDash />
            ) : (
              <div className={DIRECTORY_GRID}>
                <AddCard
                  blockedReason={addSubagentBlocked}
                  label="添加子 Agent"
                  onClick={() => onOpenPanel({ focus: undefined, type: 'subagents' })}
                />
              </div>
            )
          ) : (
            <div className={DIRECTORY_GRID}>
              {subagents.map((binding) => {
                const child = agents.find((agent) => agent.id === binding.agent)
                const name = child?.name ?? binding.agent
                const reason = child === undefined ? undefined : subagentBlockReason(child, current)
                return (
                  <DirectoryCard
                    active={panel?.type === 'subagents' && panel.focus === binding.agent}
                    badges={
                      <>
                        {binding.timeout_seconds === null ||
                        binding.timeout_seconds === undefined ? null : (
                          <CardBadge icon="timeout">{binding.timeout_seconds}s</CardBadge>
                        )}
                        {binding.max_calls === null || binding.max_calls === undefined ? null : (
                          <CardBadge icon="max-calls">×{binding.max_calls}</CardBadge>
                        )}
                      </>
                    }
                    description={child?.description}
                    icon="agent"
                    key={binding.agent}
                    label={`配置子 Agent：${name}`}
                    name={name}
                    onOpen={open({ focus: binding.agent, type: 'subagents' })}
                    tip={child === undefined ? name : `${name}\n${child.description}`}
                    trailing={reason === undefined ? undefined : <AlertGlyph reason={reason} />}
                  />
                )
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

function ModelPill({
  active = false,
  model,
  onClick,
  thinking,
}: {
  model: string | null
  thinking: Parameters<typeof thinkingLabel>[0] | null
  active?: boolean
  onClick?: () => void
}) {
  const className = cn(
    'inline-flex h-7.5 max-w-80 min-w-0 items-center gap-2 rounded-full bg-surface-container-low pr-2 pl-2.5 text-on-surface',
    active && 'bg-surface-container',
  )
  const label =
    model === null
      ? '选择模型'
      : `模型设置：${model}${thinking === null ? '' : `，思考：${thinkingLabel(thinking)}`}`
  const content = (
    <>
      <span
        className={cn(
          'min-w-0 truncate text-label font-medium tabular-nums',
          model === null && 'text-on-surface-faint',
        )}
      >
        {model ?? '选择模型'}
      </span>
      {model === null ? null : (
        <span className="shrink-0 border-l border-hairline pl-2 text-caption whitespace-nowrap text-on-surface-muted">
          {thinking === null
            ? '默认思考'
            : thinking === 'none'
              ? '不思考'
              : `思考 · ${thinkingLabel(thinking)}`}
        </span>
      )}
      {onClick === undefined ? null : (
        <Icon className="shrink-0 text-on-surface-faint" decorative name="disclosure" size="sm" />
      )}
    </>
  )
  if (onClick === undefined)
    return (
      <span aria-label={label} className={className} role="img">
        {content}
      </span>
    )
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(className, 'ui-state cursor-pointer ui-focus')}
      onClick={onClick}
      type="button"
    >
      {content}
    </button>
  )
}

function PromptCard({
  active,
  markdown,
  onOpen,
}: {
  active: boolean
  markdown: string
  onOpen: (() => void) | undefined
}) {
  const empty = markdown.trim() === ''
  const className = cn(
    'group relative block w-full rounded-md border border-border py-3.5 pr-11 pl-4 text-left text-on-surface-variant',
    active ? 'bg-surface-container-low' : 'bg-background',
  )
  const preview = empty ? (
    <span className="text-on-surface-faint">{onOpen === undefined ? '—' : '添加系统提示词'}</span>
  ) : (
    <div inert>
      <Markdown
        className="max-h-30 overflow-hidden mask-b-from-60% text-on-surface-variant [&_:is(strong,h3,h4,h5)]:text-on-surface"
        text={markdown}
      />
    </div>
  )
  if (onOpen === undefined) return <div className={className}>{preview}</div>
  return (
    <div className={cn(className, 'ui-state')}>
      {preview}
      <button
        aria-label="编辑系统提示词"
        aria-pressed={active}
        className="peer absolute inset-0 cursor-pointer rounded-md ui-focus"
        onClick={onOpen}
        type="button"
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-3 right-3 grid size-6 place-items-center text-on-surface-variant opacity-0 transition-opacity ui-motion-s group-hover:opacity-100 peer-focus-visible:opacity-100',
          active && 'opacity-100',
        )}
      >
        <Icon decorative name="edit" size="sm" />
      </span>
    </div>
  )
}
