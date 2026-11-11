import { useId, useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'
import { subagentBlockReason } from '../agent-draft'
import type { Agent, AgentConfig } from '../agents.api'

type SubagentConfig = NonNullable<AgentConfig['subagents']>[number]
import { PanelShell } from './panel-shell'
import {
  AlertGlyph,
  CARD_SWITCH_HIT,
  DIRECTORY_CARD,
  DIRECTORY_GRID,
  DirectoryCardBody,
} from './resource-card'

type Current = { id: string; isSubagent: boolean }

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
  focus: string | undefined
  onChange: (config: AgentConfig) => void
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(focus ?? null)
  const baseId = useId()
  const bindings = config.subagents ?? []
  const candidates = agents.filter(
    (agent) =>
      agent.id !== current.id &&
      (agent.status !== 'archived' || bindings.some((binding) => binding.agent === agent.id)),
  )
  const setBindings = (next: SubagentConfig[]) => onChange({ ...config, subagents: next })

  return (
    <PanelShell onClose={onClose} title="子 Agent">
      <ul className={DIRECTORY_GRID}>
        {candidates.map((candidate) => {
          const binding = bindings.find((item) => item.agent === candidate.id)
          const selected = binding !== undefined
          const open = selected && expanded === candidate.id
          const reason = subagentBlockReason(candidate, current)
          const id = `${baseId}-${candidate.id}`
          const toggle = (
            <Switch
              aria-describedby={`${id}-description`}
              aria-labelledby={`${id}-name`}
              blockedReason={selected ? undefined : reason}
              checked={selected}
              // 没加上的卡片只有开关一个操作，点卡片任意处都切换；加上后卡片本身用来展开调用限制。
              className={selected ? undefined : CARD_SWITCH_HIT}
              onCheckedChange={(on) => {
                if (on) {
                  setBindings([...bindings, { agent: candidate.id }])
                  setExpanded(candidate.id)
                } else {
                  setBindings(bindings.filter((item) => item.agent !== candidate.id))
                }
              }}
            />
          )
          const body = (
            <DirectoryCardBody
              badges={
                selected ? (
                  <>
                    <Icon
                      className={cn(
                        'shrink-0 text-on-surface-faint transition-transform ui-motion-s',
                        open && 'rotate-180',
                      )}
                      decorative
                      name="expand"
                      size="sm"
                    />
                    {reason === undefined ? null : <AlertGlyph reason={reason} />}
                  </>
                ) : undefined
              }
              description={candidate.description}
              descriptionId={`${id}-description`}
              dimmed={!selected && reason !== undefined}
              icon="agent"
              name={candidate.name}
              nameId={`${id}-name`}
            />
          )
          return (
            <li
              className={cn(
                DIRECTORY_CARD,
                'flex-wrap bg-background',
                open && '@min-[480px]:col-span-2',
              )}
              key={candidate.id}
            >
              {selected ? (
                <button
                  aria-controls={`${id}-fields`}
                  aria-expanded={open}
                  className="-m-1.5 flex min-w-0 flex-1 ui-state cursor-pointer items-center gap-3.5 rounded-md p-1.5 text-left ui-focus"
                  onClick={() => setExpanded(open ? null : candidate.id)}
                  type="button"
                >
                  {body}
                </button>
              ) : (
                body
              )}
              {toggle}
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

const parseLimit = (text: string, integer: boolean): number | null | 'invalid' => {
  if (text.trim() === '') return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)))
    return 'invalid'
  return value
}

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
      className="grid basis-full grid-cols-2 gap-3 @min-[520px]:grid-cols-[8rem_8rem_minmax(0,1fr)] @min-[520px]:pl-14.5"
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
