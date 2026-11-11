import { useId, useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { Switch } from '@/shared/ui/switch'
import type { AgentConfig } from '../agents.api'
import { bindMcp, mcpBindings, mcpStatusOf, unbindMcp } from '../mcp-draft'
import { useMcpServers } from '../mcp-servers.api'
import { StatusDot } from './mcp-status'
import type { Panel } from './panel'
import { PanelShell } from './panel-shell'
import {
  CARD_SWITCH_HIT,
  CardBadge,
  DIRECTORY_CARD,
  DIRECTORY_GRID,
  DirectoryCardBody,
} from './resource-card'

type Mode = 'mcp-library' | 'mcp-select'

export function McpListPanel({
  config,
  mode,
  onChange,
  onClose,
  onOpenPanel,
}: {
  mode: Mode
  config: AgentConfig
  onChange: (config: AgentConfig) => void
  onOpenPanel: (panel: Panel) => void
  onClose: () => void
}) {
  const servers = useMcpServers()
  const [query, setQuery] = useState('')
  const baseId = useId()
  const library = mode === 'mcp-library'
  const bound = mcpBindings(config).map((binding) => binding.server)
  const keyword = query.trim().toLowerCase()
  const items = servers.data ?? []
  const matches = items.filter((server) =>
    `${server.name} ${server.description} ${server.id}`.toLowerCase().includes(keyword),
  )
  return (
    <PanelShell onClose={onClose} title={library ? 'MCP 服务' : '管理 MCP 服务'}>
      <div className="mb-4 flex items-center gap-2">
        <Input
          aria-label="搜索 MCP 服务"
          leadingIcon="search"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索 MCP 服务"
          type="search"
          value={query}
          wrapperClassName="h-(--control-height-md) min-w-0 flex-1 rounded-sm border-transparent bg-surface-container-low focus-within:border-transparent"
        />
        <Button
          leadingIcon="add"
          onClick={() => onOpenPanel({ back: mode, server: null, type: 'mcp-server' })}
          size="md"
          variant="outlined"
        >
          添加服务
        </Button>
      </div>
      {servers.isPending ? (
        <ListPending label="正在读取 MCP 服务…" />
      ) : servers.isError ? (
        <ListError message={servers.error.message} onRetry={() => void servers.refetch()} />
      ) : (
        <>
          <ul className={DIRECTORY_GRID}>
            {matches.map((server) => {
              const on = bound.includes(server.id)
              const disabled = !server.enabled
              const blocked = !library && !on && disabled
              const id = `${baseId}-${server.id}`
              const body = (trailing: ReactNode) => (
                <DirectoryCardBody
                  badges={
                    <>
                      <StatusDot status={mcpStatusOf(server)} />
                      {disabled ? <CardBadge>已停用</CardBadge> : null}
                    </>
                  }
                  description={server.description}
                  descriptionId={`${id}-description`}
                  dimmed={blocked}
                  icon="mcp-server"
                  name={server.name}
                  nameId={`${id}-name`}
                  trailing={trailing}
                />
              )
              return (
                <li className="flex min-w-0" key={server.id}>
                  {library ? (
                    <button
                      aria-label={`编辑 MCP 服务：${server.name}`}
                      className={cn(
                        DIRECTORY_CARD,
                        'flex-1 ui-state cursor-pointer bg-background ui-focus',
                      )}
                      onClick={() =>
                        onOpenPanel({ back: mode, server: server.id, type: 'mcp-server' })
                      }
                      type="button"
                    >
                      {body(
                        <Icon
                          className="text-on-surface-faint"
                          decorative
                          name="disclosure"
                          size="sm"
                        />,
                      )}
                    </button>
                  ) : (
                    <div className={cn(DIRECTORY_CARD, 'flex-1 bg-background')}>
                      {body(
                        <Switch
                          aria-describedby={`${id}-description`}
                          aria-labelledby={`${id}-name`}
                          checked={on}
                          className={CARD_SWITCH_HIT}
                          disabled={blocked}
                          onCheckedChange={(next) =>
                            onChange(
                              next ? bindMcp(config, server.id) : unbindMcp(config, server.id),
                            )
                          }
                        />,
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {matches.length === 0 ? (
            <p className="py-8 text-center text-on-surface-faint">
              {items.length === 0 ? '暂无 MCP 服务，请点击「添加服务」登记' : '没有匹配的 MCP 服务'}
            </p>
          ) : null}
        </>
      )}
    </PanelShell>
  )
}
