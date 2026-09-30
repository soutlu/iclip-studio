/** 置灰控件的原因提示：悬停、聚焦、点按都亮出原因。
 *
 * 置灰用 aria-disabled 而不是原生 disabled：原生 disabled 的按钮收不到指针，也进不了 tab 序列，原因就没处说。
 * 子元素自己带 aria-disabled，并在 onClick 里拦下被挡时的动作。触屏没有悬停，点按也要亮出原因，做法同资料库的「做同款」。 */

import { useState, type ReactElement } from 'react'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type BlockedReasonProps = {
  /** 被挡住的原因；为 undefined 时不挂提示，子元素照常工作。 */
  reason: string | undefined
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** 单个可聚焦的触发元素，会被 Radix 以 asChild 接管。 */
  children: ReactElement
}

export function BlockedReason({ children, reason, side = 'top' }: BlockedReasonProps) {
  const [hint, setHint] = useState(false)
  const blocked = reason !== undefined
  return (
    <TooltipRoot onOpenChange={(open) => setHint(open && blocked)} open={hint && blocked}>
      <TooltipTrigger
        asChild
        // 拦下默认处理，Radix 才不会在点按时把提示关掉。
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
