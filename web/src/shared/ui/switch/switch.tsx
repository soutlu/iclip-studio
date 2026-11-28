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

/**
 * 开关：34×19 的胶囊、15px 带轻投影的圆钮。关着是凹槽配白色圆钮，开着是墨色轨道配背景色圆钮
 * （深色主题下白圆钮放在浅色轨道上看不清）。`switch-root` 是给所在页面排版的挂点。
 */
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
            'switch-root inline-flex h-4.75 w-8.5 shrink-0 cursor-pointer items-center rounded-full p-0.5 ui-focus transition-colors ui-motion-s',
            checked ? 'bg-on-surface' : 'bg-surface-container-high shadow-control-well',
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
              'size-3.75 rounded-full shadow-[var(--shadow-knob)] transition-transform ui-motion-s',
              checked ? 'translate-x-3.75 bg-background' : 'bg-knob',
            )}
          />
        </button>
      </TooltipTrigger>
      {blocked ? <TooltipContent>{blockedReason}</TooltipContent> : null}
    </TooltipRoot>
  )
}
