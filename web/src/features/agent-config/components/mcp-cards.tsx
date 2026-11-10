import type { AgentConfig } from '../agents.api'
import { MCP_STATUS_LABEL, mcpBindings, mcpStatusOf, selectedMcpTools } from '../mcp-draft'
import { useMcpServers } from '../mcp-servers.api'
import { StatusDot } from './mcp-status'
import type { Panel } from './panel'
import {
  AddCard,
  AlertGlyph,
  CardBadge,
  DIRECTORY_GRID,
  DirectoryCard,
  EmptyDash,
} from './resource-card'

export function McpCards({
  config,
  onOpenPanel,
  panel,
  readOnly,
}: {
  config: AgentConfig
  readOnly: boolean
  panel: Panel | null
  onOpenPanel: (panel: Panel) => void
}) {
  const servers = useMcpServers()
  const bindings = mcpBindings(config)
  if (bindings.length === 0)
    return readOnly ? (
      <EmptyDash />
    ) : (
      <div className={DIRECTORY_GRID}>
        <AddCard label="添加 MCP 服务" onClick={() => onOpenPanel({ type: 'mcp-select' })} />
      </div>
    )
  return (
    <div className={DIRECTORY_GRID}>
      {bindings.map((binding) => {
        const server = servers.data?.find((item) => item.id === binding.server)
        const name = server?.name ?? binding.server
        const open = readOnly
          ? undefined
          : () => onOpenPanel({ back: null, server: binding.server, type: 'mcp-server' })
        const active = panel?.type === 'mcp-server' && panel.server === binding.server
        if (server === undefined)
          return (
            <DirectoryCard
              active={active}
              icon="mcp-server"
              key={binding.server}
              label={`配置 MCP 服务：${name}`}
              name={name}
              onOpen={open}
              tip={name}
              trailing={servers.isSuccess ? <AlertGlyph reason="MCP 服务已不存在" /> : undefined}
            />
          )
        const status = mcpStatusOf(server)
        const total = server.tools?.length ?? 0
        const selected = selectedMcpTools(binding, server).length
        return (
          <DirectoryCard
            active={active}
            badges={
              <CardBadge>
                {selected}/{total}
              </CardBadge>
            }
            description={server.description}
            icon="mcp-server"
            key={binding.server}
            label={`配置 MCP 服务：${name}`}
            name={name}
            onOpen={open}
            tip={`${name}\n${server.description}\n已启用 ${selected} / ${total} 个工具，${MCP_STATUS_LABEL[status]}`}
            trailing={<StatusDot className="mx-0.5" status={status} />}
          />
        )
      })}
    </div>
  )
}
