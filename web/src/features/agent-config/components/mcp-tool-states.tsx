import { RadioGroup } from 'radix-ui'
import { useId } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { AgentConfig } from '../agents.api'
import {
  mcpBindingOf,
  mcpToolStateOf,
  selectedMcpTools,
  setMcpToolStates,
  type McpToolState,
} from '../mcp-draft'
import type { McpServer } from '../mcp-servers.api'
import { CardBadge } from './resource-card'
import { SectionHeading } from './section-heading'

const STATES: readonly { value: McpToolState; label: string; icon: IconName }[] = [
  { icon: 'success', label: '允许', value: 'allow' },
  { icon: 'confirm', label: '要求审批', value: 'ask' },
  { icon: 'blocked', label: '关闭', value: 'off' },
]

const isState = (value: string): value is McpToolState =>
  STATES.some((state) => state.value === value)

function ToolStateControl({
  disabled,
  label,
  onChange,
  value,
}: {
  label: string
  value: McpToolState
  disabled: boolean
  onChange: (state: McpToolState) => void
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      className="inline-flex shrink-0 gap-0.5 rounded-sm bg-state-active p-0.5"
      disabled={disabled}
      onValueChange={(next) => {
        if (isState(next)) onChange(next)
      }}
      orientation="horizontal"
      value={value}
    >
      {STATES.map((state) => (
        <TooltipRoot key={state.value}>
          <TooltipTrigger asChild>
            <RadioGroup.Item
              aria-label={state.label}
              className="grid h-7 w-7.5 ui-state cursor-pointer place-items-center rounded-xs text-on-surface-faint ui-focus disabled:cursor-not-allowed aria-checked:bg-top-layer aria-checked:text-on-surface aria-checked:shadow-[var(--shadow-1)]"
              value={state.value}
            >
              <Icon decorative name={state.icon} size="sm" />
            </RadioGroup.Item>
          </TooltipTrigger>
          <TooltipContent>{state.label}</TooltipContent>
        </TooltipRoot>
      ))}
    </RadioGroup.Root>
  )
}

/**
 * 工具一节：服务发现的每个工具在当前 Agent 上的状态（允许 / 要求审批 / 关闭），写进 Agent 草稿；
 * 服务没挂到当前 Agent 时只能看。
 */
export function McpToolsSection({
  config,
  creating,
  onChange,
  server,
}: {
  server: McpServer | undefined
  creating: boolean
  config: AgentConfig
  onChange: (config: AgentConfig) => void
}) {
  const titleId = useId()
  const tools = server?.tools ?? []
  const binding = server === undefined ? undefined : mcpBindingOf(config, server.id)
  const bound = binding !== undefined
  const given = binding === undefined ? 0 : selectedMcpTools(binding, server).length
  const setStates = (names: readonly string[], state: McpToolState) => {
    if (server !== undefined) onChange(setMcpToolStates(config, server, names, state))
  }

  if (tools.length === 0)
    return (
      <section aria-labelledby={titleId} className="mt-7">
        <SectionHeading id={titleId} title="工具" />
        <p className="py-2 text-body-sm text-on-surface-faint">
          {creating ? '暂无工具，保存并测试连接后列出' : '暂无工具，请先点击「测试连接」'}
        </p>
      </section>
    )

  return (
    <section aria-labelledby={titleId} className="mt-7">
      <SectionHeading
        action={
          bound ? (
            <MenuRoot>
              <MenuTrigger asChild>
                <Button
                  className="mr-1 h-(--control-height-sm) gap-1.5 px-3"
                  size="md"
                  variant="outlined"
                >
                  全部设为
                  <Icon className="text-on-surface-faint" decorative name="expand" size="sm" />
                </Button>
              </MenuTrigger>
              <MenuSurface align="end">
                {STATES.map((state) => (
                  <MenuItem
                    icon={state.icon}
                    key={state.value}
                    onSelect={() =>
                      setStates(
                        tools.map((tool) => tool.name),
                        state.value,
                      )
                    }
                  >
                    {state.label}
                  </MenuItem>
                ))}
              </MenuSurface>
            </MenuRoot>
          ) : undefined
        }
        badges={
          <span aria-label={`已放给 Agent ${given} / ${tools.length} 个工具`} role="img">
            <CardBadge>
              {given}/{tools.length}
            </CardBadge>
          </span>
        }
        id={titleId}
        note={
          bound
            ? '选择这个 Agent 何时可以使用这些工具'
            : '当前 Agent 还没有挂这个服务，请先在「管理 MCP 服务」里添加'
        }
        title="工具"
      />
      <ul className="flex flex-col">
        {tools.map((tool) => {
          const label = tool.title ?? tool.name
          return (
            <li
              className="flex min-h-13 min-w-0 items-center gap-3 border-t border-hairline first:border-t-0"
              key={tool.name}
            >
              <span className="flex min-w-0 flex-1 flex-col py-2">
                <span className="truncate text-body text-on-surface" title={tool.name}>
                  {label}
                </span>
                {tool.description === null || tool.description === '' ? null : (
                  <span className="truncate text-label text-on-surface-faint">
                    {tool.description}
                  </span>
                )}
              </span>
              <ToolStateControl
                disabled={!bound}
                label={label}
                onChange={(state) => setStates([tool.name], state)}
                value={binding === undefined ? 'off' : mcpToolStateOf(binding, tool.name)}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
