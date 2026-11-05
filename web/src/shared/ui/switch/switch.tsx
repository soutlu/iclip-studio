import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'

type SwitchProps = Omit<
  ComponentPropsWithRef<'button'>,
  'children' | 'onChange' | 'role' | 'title' | 'type'
> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  blockedReason?: string | undefined
}

export function Switch({
  blockedReason,
  checked,
  className,
  disabled = false,
  onCheckedChange,
  onClick,
  ...props
}: SwitchProps) {
  const { rootProps, triggerProps } = useTabTooltip()
  const blocked = blockedReason !== undefined
  return (
    <TooltipRoot {...rootProps} open={rootProps.open && blocked}>
      <TooltipTrigger asChild {...triggerProps}>
        <button
          aria-checked={checked}
          aria-disabled={blocked ? true : undefined}
          className={cn(
            'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 ui-focus transition-colors ui-motion-s',
            checked ? 'bg-on-surface' : 'bg-outline-variant',
            'disabled:cursor-not-allowed disabled:opacity-(--state-disabled-content) aria-disabled:cursor-not-allowed',
            className,
          )}
          disabled={disabled}
          onClick={(event) => {
            onClick?.(event)
            if (blocked || event.defaultPrevented) return
            onCheckedChange(!checked)
          }}
          role="switch"
          type="button"
          {...props}
        >
          <span
            aria-hidden
            className={cn(
              'size-4 rounded-full bg-background transition-transform ui-motion-s',
              checked && 'translate-x-4',
            )}
          />
        </button>
      </TooltipTrigger>
      {blocked ? <TooltipContent>{blockedReason}</TooltipContent> : null}
    </TooltipRoot>
  )
}
