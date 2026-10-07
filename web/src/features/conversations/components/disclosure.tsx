/** 参考 Kimi 折叠过渡：外层 grid-rows 0fr→1fr 配合内层 min-h-0 overflow-hidden，避免收起时溢出。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

/** 收起时内容仍在 DOM 里撑过渡，所以同时对读屏和键盘隐藏。 */
export function DisclosureBody({ children, open }: { children: ReactNode; open: boolean }) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'grid transition-[grid-template-rows] duration-(--dur-s) ease-(--ease)',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/** 照 Kimi：收起时朝右，展开转到朝下。 */
export function DisclosureChevron({ className, open }: { className?: string; open: boolean }) {
  return (
    <Icon
      className={cn(
        'shrink-0 transition-transform duration-(--dur-s) ease-(--ease)',
        !open && '-rotate-90',
        className,
      )}
      decorative
      name="expand"
      size="xs"
    />
  )
}
