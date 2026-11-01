import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MarkdownPreview } from '@/shared/ui/markdown-editor'
import { ThinkingEmoji, thinkingLabel } from '@/shared/ui/thinking-level'
import {
  enabledPluginNames,
  missingRequiresReason,
  subagentBlockReason,
  type DraftValue,
  type EditorSection,
} from '../agent-draft'
import type { Agent, AgentPlugin, Skill } from '../agents.api'
import { pluginIcon } from '../plugin-icons'
import type { Panel } from './panel'
import { AddCard, AlertGlyph, CardBadge, EmptyDash, ResourceCard } from './resource-card'

const GRID = 'grid grid-cols-2 gap-2 @min-[600px]:grid-cols-3 @max-[360px]:grid-cols-1'
// 子 Agent 卡片尾部有时限与次数两枚角标，两列才放得下名字。
const WIDE_GRID = 'grid grid-cols-2 gap-2 @max-[360px]:grid-cols-1'

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
        <h2 className="flex items-center gap-1.5 text-body font-semibold text-on-surface">
          {title}
          {problems === undefined ? null : (
            <Icon className="text-error" decorative name="alert" size="sm" />
          )}
        </h2>
        {actions === undefined ? null : (
          <div className="-mr-1 flex items-center gap-1">{actions}</div>
        )}
      </div>
      {problems === undefined ? null : <ProblemList problems={problems} />}
      {children}
    </section>
  )
}

/** 发布被拦下的原因，就地写在出问题的那一节里，改了草稿才收起。 */
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
  /** 看历史版本：只读，不开面板。 */
  readOnly: boolean
  current: { id: string; isSubagent: boolean }
  agents: readonly Agent[]
  plugins: readonly AgentPlugin[]
  skills: readonly Skill[]
  problems: SectionProblems
  panel: Panel | null
  onOpenPanel: (panel: Panel) => void
}

/** 左栏的配置摘要：指令（模型与提示词）、技能、插件、子 Agent；细节都在右侧面板里改。 */
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

  // 发布被拦下时滚到第一处出问题的那一节。
  const firstProblem = (
    ['general', 'instructions', 'skills', 'plugins', 'subagents'] as const
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

        <Section problems={problems.skills} section="skills" title="技能">
          {value.skillIds.length === 0 ? (
            <EmptyDash />
          ) : (
            <div className={GRID}>
              {value.skillIds.map((id) => {
                const skill = skills.find((item) => item.id === id)
                const name = skill?.displayName ?? id
                return (
                  <ResourceCard
                    icon="skill"
                    key={id}
                    name={name}
                    tip={skill === undefined ? name : `${name}\n${skill.description}`}
                    trailing={
                      skill?.latestVersion === null || skill === undefined ? undefined : (
                        <CardBadge>v{skill.latestVersion}</CardBadge>
                      )
                    }
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
              <div className={GRID}>
                <AddCard label="启用插件" onClick={() => onOpenPanel({ type: 'plugins' })} />
              </div>
            )
          ) : (
            <div className={GRID}>
              {enabled.map((name) => {
                const plugin = plugins.find((item) => item.name === name)
                const label = plugin?.label ?? name
                const missing =
                  plugin === undefined ? undefined : missingRequiresReason(plugin, enabled, plugins)
                return (
                  <ResourceCard
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
                disabled={addSubagentBlocked !== undefined}
                label="添加子 Agent"
                name="add"
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
              <div className={WIDE_GRID}>
                <AddCard
                  blockedReason={addSubagentBlocked}
                  label="添加子 Agent"
                  onClick={() => onOpenPanel({ focus: undefined, type: 'subagents' })}
                />
              </div>
            )
          ) : (
            <div className={WIDE_GRID}>
              {subagents.map((binding) => {
                const child = agents.find((agent) => agent.id === binding.agent)
                const name = child?.name ?? binding.agent
                const reason = child === undefined ? undefined : subagentBlockReason(child, current)
                return (
                  <ResourceCard
                    active={panel?.type === 'subagents' && panel.focus === binding.agent}
                    icon="agent"
                    key={binding.agent}
                    label={`配置子 Agent：${name}`}
                    name={name}
                    onOpen={open({ focus: binding.agent, type: 'subagents' })}
                    tip={child === undefined ? name : `${name}\n${child.description}`}
                    trailing={
                      <>
                        {reason === undefined ? null : <AlertGlyph reason={reason} />}
                        {binding.timeout_seconds === null ||
                        binding.timeout_seconds === undefined ? null : (
                          <CardBadge icon="timeout">{binding.timeout_seconds}s</CardBadge>
                        )}
                        {binding.max_calls === null || binding.max_calls === undefined ? null : (
                          <CardBadge icon="max-calls">×{binding.max_calls}</CardBadge>
                        )}
                      </>
                    }
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

/** 模型胶囊：思考档位 emoji + 模型名 + 箭头；不给 onClick 是只读的（看历史版本）。 */
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
    'inline-flex h-7.5 max-w-80 shrink-0 items-center gap-1.5 rounded-full bg-surface-container-low pr-2 pl-2.5 text-on-surface',
    active && 'bg-surface-container',
  )
  const label =
    model === null
      ? '选择模型'
      : `模型设置：${model}${thinking === null ? '' : `，思考：${thinkingLabel(thinking)}`}`
  const content = (
    <>
      {thinking === null ? null : <ThinkingEmoji level={thinking} />}
      <span
        className={cn(
          'min-w-0 truncate text-label font-medium tabular-nums',
          model === null && 'text-on-surface-faint',
        )}
      >
        {model ?? '选择模型'}
      </span>
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

/** 系统提示词的排版预览：只露开头几行、底部渐隐，悬停出铅笔；空的时候是添加入口。 */
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
    'group relative block w-full rounded-md bg-surface-container-low py-3.5 pr-11 pl-4 text-left text-on-surface-variant',
    active && 'bg-surface-container-high',
  )
  const preview = empty ? (
    <span className="text-on-surface-faint">{onOpen === undefined ? '—' : '添加系统提示词'}</span>
  ) : (
    <MarkdownPreview
      className="max-h-30 overflow-hidden mask-b-from-60% [&_:is(strong,h1,h2,h3,h4)]:text-on-surface"
      value={markdown}
    />
  )
  if (onOpen === undefined) return <div className={className}>{preview}</div>
  return (
    <button
      aria-label="编辑系统提示词"
      aria-pressed={active}
      className={cn(className, 'ui-state cursor-pointer ui-focus')}
      onClick={onOpen}
      type="button"
    >
      {preview}
      <span
        aria-hidden
        className={cn(
          'absolute top-3 right-3 grid size-6 place-items-center text-on-surface-variant opacity-0 transition-opacity ui-motion-s group-hover:opacity-100 group-focus-visible:opacity-100',
          active && 'opacity-100',
        )}
      >
        <Icon decorative name="edit" size="sm" />
      </span>
    </button>
  )
}
