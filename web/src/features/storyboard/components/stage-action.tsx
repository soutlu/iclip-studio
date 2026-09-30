/** 舞台操作行上的带字按钮：图标加文字，操作行窄时文字由容器查询收起、退成图标，这时悬停或聚焦用提示说出名字；
 * 被挡住时置灰（aria-disabled），悬停、聚焦、点按说原因。收起的阈值只写在 storyboard.css 的「舞台操作行」一节。 */

import { useRef, useState, type ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from './blocked-reason'
import { STAGE_ACTION_TEXT, stageActionClass } from './workbench-control'

type StageActionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> & {
  icon: IconName
  /** 可访问名称，退成图标时的提示也是它。 */
  label: string
  /** 可见文字，缺省同 `label`；要短写时给，须是 `label` 的一部分。 */
  text?: string | undefined
  /** 被挡住的原因；有值时置灰，点了不调 `onClick`。 */
  blocker?: string | undefined
}

export function StageAction({
  blocker,
  className,
  icon,
  label,
  onClick,
  text = label,
  ...props
}: StageActionProps) {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const [hint, setHint] = useState(false)
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
      <span className={STAGE_ACTION_TEXT} ref={textRef}>
        {text}
      </span>
    </button>
  )
  if (blocker !== undefined) return <BlockedReason reason={blocker}>{button}</BlockedReason>
  return (
    // 文字露着时不重复提示；收起与否以样式算出的结果为准，不另定一份阈值。
    <TooltipRoot onOpenChange={(open) => setHint(open && textHidden(textRef.current))} open={hint}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </TooltipRoot>
  )
}

const textHidden = (text: HTMLElement | null) =>
  text !== null && getComputedStyle(text).display === 'none'
