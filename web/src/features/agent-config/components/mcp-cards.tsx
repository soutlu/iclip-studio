import type { AgentConfig } from '../agents.api'
import { MCP_STATUS_LABEL, mcpBindings, mcpStatusOf, selectedMcpTools } from '../mcp-draft'
import { useMcpServers } from '../mcp-servers.api'
import { StatusDot } from './mcp-status'
import type { Panel } from './panel'
import { AddCard, AlertGlyph, CardBadge, EmptyDash, ResourceCard } from './resource-card'

const GRID = 'grid grid-cols-2 gap-2 @min-[600px]:grid-cols-3 @max-[360px]:grid-cols-1'

/**
 * 左侧「MCP 服务」一节的卡片：名字、放出的工具数 / 发现的工具数、连接状态；点开右侧是它的配置。
 * 没挂的时候草稿里是添加卡、历史版本里是一道短线。服务已不在库里时只写标识并标红，留给发布检查。
 */
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
      <div className={GRID}>
        <AddCard label="添加 MCP 服务" onClick={() => onOpenPanel({ type: 'mcp-select' })} />
      </div>
    )
  return (
    <div className={GRID}>
      {bindings.map((binding) => {
        const server = servers.data?.find((item) => item.id === binding.server)
        const name = server?.name ?? binding.server
        const open = readOnly
          ? undefined
          : () => onOpenPanel({ back: null, server: binding.server, type: 'mcp-server' })
        const active = panel?.type === 'mcp-server' && panel.server === binding.server
        if (server === undefined)
          return (
            <ResourceCard
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
          <ResourceCard
            active={active}
            icon="mcp-server"
            key={binding.server}
            label={`配置 MCP 服务：${name}`}
            name={name}
            onOpen={open}
            tip={`${name}\n${server.description}\n已启用 ${selected} / ${total} 个工具，${MCP_STATUS_LABEL[status]}`}
            trailing={
              <>
                <CardBadge>
                  {selected}/{total}
                </CardBadge>
                <StatusDot className="mx-0.5" status={status} />
              </>
            }
          />
        )
      })}
    </div>
  )
}
