import { useState, type ReactElement } from 'react'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type BlockedReasonProps = {
  reason: string | undefined
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Tooltip 挂载容器；未传入时默认挂在文档根节点（全屏状态下需指定全屏元素方可正常显示）。 */
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
