import { useState, type ReactElement } from 'react'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type BlockedReasonProps = {
  reason: string | undefined
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** 说明挂到哪；不给时挂在页面上（全屏时要挂到全屏的那块元素里才看得见）。 */
  container?: HTMLElement | null
  children: ReactElement
}

export function BlockedReason({
  children,
  reason,
  side = 'top',
  container = null,
}: BlockedReasonProps) {
  const [hint, setHint] = useState(false)
  const blocked = reason !== undefined
  return (
    <TooltipRoot onOpenChange={(open) => setHint(open && blocked)} open={hint && blocked}>
      <TooltipTrigger
        asChild
        onClick={(event) => {
          if (!blocked) return
          event.preventDefault()
          setHint(true)
        }}
      >
        {children}
      </TooltipTrigger>
      {blocked ? (
        <TooltipContent container={container} side={side}>
          {reason}
        </TooltipContent>
      ) : null}
    </TooltipRoot>
  )
}
