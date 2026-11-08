import { cva, type VariantProps } from 'class-variance-authority'
import { ToggleGroup } from 'radix-ui'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

const groupVariants = cva('', {
  variants: {
    variant: {
      chip: 'flex flex-wrap items-center gap-2',
      segmented:
        'grid h-8 shrink-0 auto-cols-fr grid-flow-col rounded-sm bg-surface-container p-0.75',
    },
  },
  defaultVariants: { variant: 'chip' },
})

const itemVariants = cva(
  'hit-48 relative inline-flex ui-state cursor-pointer items-center text-body-sm text-on-surface-variant ui-focus data-[state=on]:text-on-surface',
  {
    variants: {
      variant: {
        chip: 'h-(--control-height-sm) gap-[7px] rounded-full border border-chip-border bg-chip-bg px-[15px] font-medium data-[state=on]:border-transparent data-[state=on]:bg-state-active',
        segmented:
          'h-full min-w-0 justify-center gap-1 rounded-xs px-1 whitespace-nowrap data-[state=on]:bg-surface-container-lowest data-[state=on]:font-medium data-[state=on]:shadow-[var(--shadow-1)]',
      },
    },
    defaultVariants: { variant: 'chip' },
  },
)

type ChipGroupProps = ComponentPropsWithoutRef<typeof ToggleGroup.Root> &
  VariantProps<typeof groupVariants>

export function ChipGroup({ className, variant, ...props }: ChipGroupProps) {
  return <ToggleGroup.Root className={cn(groupVariants({ variant }), className)} {...props} />
}

type FilterChipProps = ComponentPropsWithoutRef<typeof ToggleGroup.Item> &
  VariantProps<typeof itemVariants> & {
    children: ReactNode
    leadingIcon?: IconName
  }

export function FilterChip({
  children,
  className,
  leadingIcon,
  variant,
  ...props
}: FilterChipProps) {
  return (
    <ToggleGroup.Item className={cn(itemVariants({ variant }), className)} {...props}>
      {leadingIcon ? <Icon decorative name={leadingIcon} size="sm" /> : null}
      {children}
    </ToggleGroup.Item>
  )
}
