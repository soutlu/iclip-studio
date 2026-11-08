import { cva, type VariantProps } from 'class-variance-authority'
import { useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

export const iconButtonVariants = cva(
  'relative inline-grid ui-state cursor-pointer place-items-center rounded-sm ui-focus active:scale-[0.98] aria-disabled:active:scale-100',
  {
    variants: {
      variant: {
        standard: 'bg-transparent text-on-surface-variant',
        tonal: 'bg-secondary-container text-on-secondary-container',
        selected: 'bg-inverse-surface text-inverse-on-surface',
      },
      size: {
        lg: 'hit-48 size-(--control-height-lg)',
        md: 'hit-48 size-(--control-height-md)',
        sm: 'size-(--control-height-sm)',
        xs: 'size-(--control-height-xs)',
      },
    },
    defaultVariants: { variant: 'standard', size: 'lg' },
  },
)

const ICON_SIZE = { lg: 'lg', md: 'md', sm: 'md', xs: 'sm' } as const

type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'title'> &
  VariantProps<typeof iconButtonVariants> & {
    label: string
    name: IconName
    tooltip?: string | undefined
    badge?: ReactNode
  }

export function IconButton({
  badge,
  className,
  disabled = false,
  label,
  name,
  onClick,
  onFocus,
  onKeyUp,
  size,
  tooltip,
  type = 'button',
  variant,
  ...props
}: IconButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <TooltipRoot onOpenChange={setOpen} open={open}>
      <TooltipTrigger asChild>
        <button
          aria-disabled={disabled ? true : undefined}
          aria-label={label}
          className={cn(iconButtonVariants({ variant, size }), className)}
          type={type}
          {...props}
          onClick={(event) => {
            if (disabled) {
              event.preventDefault()
              return
            }
            onClick?.(event)
          }}
          onFocus={(event) => {
            onFocus?.(event)
            event.preventDefault()
          }}
          onKeyUp={(event) => {
            onKeyUp?.(event)
            if (event.key === 'Tab') setOpen(true)
          }}
        >
          <Icon decorative name={name} size={ICON_SIZE[size ?? 'lg']} />
          {badge}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </TooltipRoot>
  )
}
