import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { ListError, ListPending } from '@/shared/ui/list-state'
import type { AgentConfig } from '../agents.api'
import { bindMcp, mcpBindings, mcpStatusOf, unbindMcp } from '../mcp-draft'
import { useMcpServers } from '../mcp-servers.api'
import { StatusDot } from './mcp-status'
import type { Panel } from './panel'
import { PanelShell } from './panel-shell'
import { CardBadge, CardGlyph } from './resource-card'

type Mode = 'mcp-library' | 'mcp-select'

/**
 * MCP 服务的列表面板，两种用法：服务库（顶部导航）点一行进它的配置；管理（左侧一节）点一行给当前 agent
 * 挂上或摘下，挂上时放出它的全部工具。两种都能「添加服务」，填完测试通过并保存后出现在列表里。
 */
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
        {/* 搜索框同插件面板：浅灰底、不描边，聚焦也不出框。 */}
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
          <ul className="grid grid-cols-1 gap-x-3 gap-y-1 @min-[560px]:grid-cols-2">
            {matches.map((server) => {
              const on = bound.includes(server.id)
              const disabled = !server.enabled
              const blocked = !library && !on && disabled
              return (
                <li className="min-w-0" key={server.id}>
                  <button
                    aria-disabled={blocked ? true : undefined}
                    aria-label={library ? `编辑 MCP 服务：${server.name}` : server.name}
                    aria-pressed={library ? undefined : on}
                    className={cn(
                      'flex min-h-15 w-full min-w-0 ui-state cursor-pointer items-center gap-3 rounded-md p-2.5 text-left ui-focus',
                      blocked && 'cursor-not-allowed',
                    )}
                    onClick={() => {
                      if (library)
                        onOpenPanel({ back: mode, server: server.id, type: 'mcp-server' })
                      else if (on) onChange(unbindMcp(config, server.id))
                      else if (!blocked) onChange(bindMcp(config, server.id))
                    }}
                    type="button"
                  >
                    <CardGlyph className="size-9 bg-surface-container-low" name="mcp-server" />
                    <span className={cn('flex min-w-0 flex-1 flex-col', blocked && 'opacity-55')}>
                      <span className="flex min-w-0 items-center gap-1.5 font-medium text-on-surface">
                        <span className="truncate">{server.name}</span>
                        <StatusDot status={mcpStatusOf(server)} />
                        {disabled ? <CardBadge>已停用</CardBadge> : null}
                      </span>
                      <span className="truncate text-label text-on-surface-faint">
                        {server.description}
                      </span>
                    </span>
                    <Icon
                      className={cn(
                        'shrink-0',
                        !library && on ? 'text-on-surface' : 'text-on-surface-faint',
                      )}
                      decorative
                      name={library ? 'disclosure' : on ? 'check' : 'add'}
                      size="md"
                    />
                  </button>
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
