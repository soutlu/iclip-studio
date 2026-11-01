import { useId, useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { subagentBlockReason } from '../agent-draft'
import type { Agent, AgentConfig } from '../agents.api'

type SubagentConfig = NonNullable<AgentConfig['subagents']>[number]
import { PanelShell } from './panel-shell'
import { AlertGlyph, CardGlyph } from './resource-card'

type Current = { id: string; isSubagent: boolean }

/**
 * 从已有的 agent 里选子 agent，不在这里新建；开着的一行在行内展开它的时限、次数与失败提示。
 * 不能选的开关被拦下、原因在提示里；已选的后来不合规矩了也不自动去掉，标红留给发布检查。
 */
export function SubagentPanel({
  agents,
  config,
  current,
  focus,
  onChange,
  onClose,
}: {
  agents: readonly Agent[]
  config: AgentConfig
  current: Current
  /** 从左侧某张卡片点进来时先展开它。 */
  focus: string | undefined
  onChange: (config: AgentConfig) => void
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(focus ?? null)
  const baseId = useId()
  const bindings = config.subagents ?? []
  // 已归档的只在还绑着时列出来。
  const candidates = agents.filter(
    (agent) =>
      agent.id !== current.id &&
      (agent.status !== 'archived' || bindings.some((binding) => binding.agent === agent.id)),
  )
  const setBindings = (next: SubagentConfig[]) => onChange({ ...config, subagents: next })

  return (
    <PanelShell onClose={onClose} title="子 Agent">
      <ul className="flex flex-col gap-1">
        {candidates.map((candidate) => {
          const binding = bindings.find((item) => item.agent === candidate.id)
          const selected = binding !== undefined
          const open = selected && expanded === candidate.id
          const reason = subagentBlockReason(candidate, current)
          const id = `${baseId}-${candidate.id}`
          return (
            <li className={cn('rounded-md', open && 'bg-surface-container-low')} key={candidate.id}>
              <div className="flex items-center gap-3 pr-3">
                <button
                  aria-controls={selected ? `${id}-fields` : undefined}
                  aria-expanded={selected ? open : undefined}
                  className={cn(
                    'flex min-h-15 min-w-0 flex-1 items-center gap-3 rounded-md p-2.5 text-left ui-focus',
                    selected ? 'ui-state cursor-pointer' : 'cursor-default',
                  )}
                  disabled={!selected}
                  onClick={() => setExpanded(open ? null : candidate.id)}
                  type="button"
                >
                  <CardGlyph
                    className={cn(
                      'size-9',
                      open ? 'bg-top-layer' : 'bg-surface-container-low',
                      !selected && reason !== undefined && 'opacity-55',
                    )}
                    name="agent"
                  />
                  <span
                    className={cn(
                      'flex min-w-0 flex-1 flex-col',
                      !selected && reason !== undefined && 'opacity-55',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-on-surface">
                      <span className="truncate" id={`${id}-name`}>
                        {candidate.name}
                      </span>
                      {selected ? (
                        <Icon
                          className={cn(
                            'shrink-0 text-on-surface-faint transition-transform ui-motion-s',
                            open && 'rotate-180',
                          )}
                          decorative
                          name="expand"
                          size="sm"
                        />
                      ) : null}
                      {selected && reason !== undefined ? <AlertGlyph reason={reason} /> : null}
                    </span>
                    <span
                      className="truncate text-label text-on-surface-faint"
                      id={`${id}-description`}
                    >
                      {candidate.description}
                    </span>
                  </span>
                </button>
                <Switch
                  aria-describedby={`${id}-description`}
                  aria-labelledby={`${id}-name`}
                  blockedReason={selected ? undefined : reason}
                  checked={selected}
                  onCheckedChange={(on) => {
                    if (on) {
                      setBindings([...bindings, { agent: candidate.id }])
                      setExpanded(candidate.id)
                    } else {
                      setBindings(bindings.filter((item) => item.agent !== candidate.id))
                    }
                  }}
                />
              </div>
              {open ? (
                <BindingFields
                  binding={binding}
                  id={`${id}-fields`}
                  name={candidate.name}
                  onChange={(next) =>
                    setBindings(bindings.map((item) => (item.agent === candidate.id ? next : item)))
                  }
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      {candidates.length === 0 ? (
        <p className="py-8 text-center text-on-surface-faint">暂无其他 Agent</p>
      ) : null}
    </PanelShell>
  )
}

/** 正数：时限可以带小数，次数要整数。空着就是不限，合同里不写。 */
const parseLimit = (text: string, integer: boolean): number | null | 'invalid' => {
  if (text.trim() === '') return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)))
    return 'invalid'
  return value
}

/** 一个子 agent 的调用参数。输入不合格时只在原处标出、不写进草稿，草稿里留着上一个合格的值。 */
function BindingFields({
  binding,
  id,
  name,
  onChange,
}: {
  binding: SubagentConfig
  id: string
  name: string
  onChange: (binding: SubagentConfig) => void
}) {
  const [timeoutText, setTimeoutText] = useState(binding.timeout_seconds?.toString() ?? '')
  const [callsText, setCallsText] = useState(binding.max_calls?.toString() ?? '')
  const timeoutValue = parseLimit(timeoutText, false)
  const callsValue = parseLimit(callsText, true)
  const baseId = useId()
  return (
    <div
      className="grid grid-cols-2 gap-3 px-3 pt-1 pb-3.5 @min-[520px]:grid-cols-[8rem_8rem_minmax(0,1fr)] @min-[520px]:pl-14.5"
      id={id}
    >
      <LimitField
        error={timeoutValue === 'invalid' ? '请填大于 0 的秒数' : undefined}
        icon="timeout"
        id={`${baseId}-timeout`}
        label="时限"
        name={`${name}的调用时限（秒）`}
        onChange={(text) => {
          setTimeoutText(text)
          const value = parseLimit(text, false)
          if (value !== 'invalid') onChange({ ...binding, timeout_seconds: value })
        }}
        suffix="秒"
        value={timeoutText}
      />
      <LimitField
        error={callsValue === 'invalid' ? '请填大于 0 的整数' : undefined}
        icon="max-calls"
        id={`${baseId}-calls`}
        label="次数"
        name={`${name}的调用次数上限`}
        onChange={(text) => {
          setCallsText(text)
          const value = parseLimit(text, true)
          if (value !== 'invalid') onChange({ ...binding, max_calls: value })
        }}
        suffix="次"
        value={callsText}
      />
      <div className="col-span-2 flex flex-col gap-1.5 @min-[520px]:col-span-1">
        <label className="text-label text-on-surface-variant" htmlFor={`${baseId}-failure`}>
          失败提示
        </label>
        <Input
          aria-label={`${name}的失败提示`}
          className="h-(--control-height-md) bg-top-layer px-3"
          id={`${baseId}-failure`}
          onChange={(event) => {
            const text = event.currentTarget.value
            onChange({ ...binding, on_failure: text === '' ? null : text })
          }}
          placeholder="调用失败时告诉主 Agent 的话"
          value={binding.on_failure ?? ''}
        />
      </div>
    </div>
  )
}

function LimitField({
  error,
  icon,
  id,
  label,
  name,
  onChange,
  suffix,
  value,
}: {
  error: string | undefined
  icon: IconName
  id: string
  label: string
  name: string
  onChange: (text: string) => void
  suffix: string
  value: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        className="inline-flex items-center gap-1 text-label text-on-surface-variant"
        htmlFor={id}
      >
        <Icon decorative name={icon} size="xs" />
        {label}
      </label>
      <span className="relative block">
        <Input
          aria-describedby={error === undefined ? undefined : `${id}-error`}
          aria-invalid={error !== undefined}
          aria-label={name}
          className="h-(--control-height-md) bg-top-layer pr-8 pl-3 tabular-nums"
          id={id}
          inputMode="decimal"
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="不限"
          value={value}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-label text-on-surface-faint"
        >
          {suffix}
        </span>
      </span>
      {error === undefined ? null : (
        <span className="text-label text-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  )
}
