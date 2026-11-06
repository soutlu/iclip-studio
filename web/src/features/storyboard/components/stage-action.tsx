import type { ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from './blocked-reason'
import { useCollapsedTextHint } from './use-collapsed-text-hint'
import { STAGE_ACTION_TEXT, stageActionClass } from './workbench-control'

type StageActionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> & {
  icon: IconName
  label: string
  text?: string | undefined
  blocker?: string | undefined
}

const TOOLTIP_SIDE = 'bottom'

export function StageAction({
  blocker,
  className,
  icon,
  label,
  onClick,
  text,
  ...props
}: StageActionProps) {
  const { bindText, tooltip } = useCollapsedTextHint()
  const button = (
    <button
      aria-disabled={blocker === undefined ? undefined : true}
      aria-label={label}
      className={cn(stageActionClass, className)}
      onClick={(event) => {
        if (blocker === undefined) onClick?.(event)
      }}
      type="button"
      {...props}
    >
      <Icon decorative name={icon} size="sm" />
      {text === undefined ? null : (
        <span className={STAGE_ACTION_TEXT} ref={bindText}>
          {text}
        </span>
      )}
    </button>
  )
  if (blocker !== undefined)
    return (
      <BlockedReason reason={blocker} side={TOOLTIP_SIDE}>
        {button}
      </BlockedReason>
    )
  return (
    <TooltipRoot {...(text === undefined ? {} : tooltip)}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={TOOLTIP_SIDE}>{label}</TooltipContent>
    </TooltipRoot>
  )
}
