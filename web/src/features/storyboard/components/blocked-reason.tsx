import { useState, type ReactElement } from 'react'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type BlockedReasonProps = {
  reason: string | undefined
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}

export function BlockedReason({ children, reason, side = 'top' }: BlockedReasonProps) {
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
      {blocked ? <TooltipContent side={side}>{reason}</TooltipContent> : null}
    </TooltipRoot>
  )
}
