import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

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
