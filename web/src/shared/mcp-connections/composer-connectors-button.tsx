import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { iconButtonVariants } from '@/shared/ui/button'
import { MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'
import { McpConnectionRow } from './connection-row'
import { type McpConnectionsScope, useMcpConnections } from './mcp-connections.api'

/**
 * 输入框「+」旁的连接器按钮（放在 `Composer` 的 `leading` 里）：这段对话运行会连使用自有账户的服务时才出现，
 * 点开向上弹出各服务的连接；有连接已失效时按钮上带红点。读取中、没有这类服务或读取失败时不显示。
 */
export function ComposerConnectorsButton({ scope }: { scope: McpConnectionsScope }) {
  const connections = useMcpConnections(scope)
  const [menuOpen, setMenuOpen] = useState(false)
  const tooltip = useTabTooltip()
  const items = connections.data ?? []
  if (items.length === 0) return null

  const invalid = items.some((item) => item.state === 'invalid')
  return (
    <MenuRoot
      onOpenChange={(open) => {
        setMenuOpen(open)
        tooltip.rootProps.onOpenChange(false)
      }}
      open={menuOpen}
    >
      {/* 不用 IconButton：点开后指针还停在按钮上，它的悬停提示会重新出现、压在向上弹出的列表底下。 */}
      <TooltipRoot
        onOpenChange={tooltip.rootProps.onOpenChange}
        open={tooltip.rootProps.open && !menuOpen}
      >
        <MenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              aria-label={invalid ? '连接器，有连接已失效' : '连接器'}
              className={cn(
                iconButtonVariants({ size: 'md' }),
                'data-[state=open]:bg-state-active',
              )}
              type="button"
              {...tooltip.triggerProps}
            >
              <Icon decorative name="mcp-server" size="md" />
              {invalid ? (
                <span
                  aria-hidden
                  className="absolute top-1.25 right-1.25 size-1.5 rounded-full bg-error"
                />
              ) : null}
            </button>
          </TooltipTrigger>
        </MenuTrigger>
        <TooltipContent>连接器</TooltipContent>
      </TooltipRoot>
      {/* 窄屏上离屏幕边缘留出间距，放不下 320px 时按可用宽度收窄。 */}
      <MenuSurface
        align="start"
        className="w-80 max-w-(--radix-dropdown-menu-content-available-width)"
        collisionPadding={12}
        side="top"
        sideOffset={8}
      >
        {items.map((connection) => (
          <McpConnectionRow connection={connection} key={connection.serverId} />
        ))}
      </MenuSurface>
    </MenuRoot>
  )
}
