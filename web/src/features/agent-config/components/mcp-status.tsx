import { cn } from '@/shared/lib/utils'
import { MCP_STATUS_LABEL, type McpStatus } from '../mcp-draft'

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
