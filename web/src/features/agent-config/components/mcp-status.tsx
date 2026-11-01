import { cn } from '@/shared/lib/utils'
import { MCP_STATUS_LABEL, type McpStatus } from '../mcp-draft'

/** 连接状态的小圆点：通了是主色（绿），没通是错误色，还没试过是灰色；状态写在可访问名里。 */
export function StatusDot({ status, className }: { status: McpStatus; className?: string }) {
  return (
    <span
      aria-label={MCP_STATUS_LABEL[status]}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        status === 'connected' && 'bg-primary',
        status === 'failed' && 'bg-error',
        status === 'unchecked' && 'bg-outline-variant',
        className,
      )}
      role="img"
    />
  )
}
