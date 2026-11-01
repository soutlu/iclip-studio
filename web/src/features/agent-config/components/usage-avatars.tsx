import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { usageNames, type AgentUsage } from '../model-providers.api'

const SHOWN = 3

/**
 * 「谁在用」：引用它的 agent 各一个首字头像，叠成一排，多于 3 个的收成 +N；名字在悬停提示与可访问名里。
 * 没人在用时什么都不画。
 */
export function UsageAvatars({ users }: { users: readonly AgentUsage[] }) {
  if (users.length === 0) return null
  const label = `在用：${usageNames(users)}`
  const rest = users.length - SHOWN
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span aria-label={label} className="inline-flex shrink-0 items-center" role="img">
          {users.slice(0, SHOWN).map((user, index) => (
            <span
              aria-hidden
              className={cn(
                'grid size-4 place-items-center rounded-full bg-surface-container-high text-caption font-semibold text-on-surface-variant ring-2 ring-background',
                index > 0 && '-ml-1',
              )}
              key={user.agentId}
            >
              {Array.from(user.agentName)[0]}
            </span>
          ))}
          {rest > 0 ? (
            <span aria-hidden className="ml-1 text-caption text-on-surface-variant tabular-nums">
              +{rest}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </TooltipRoot>
  )
}
