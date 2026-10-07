/** 舞台工具条上的深色玻璃按钮。带字（`text`）时图标加文字，舞台窄时文字由容器查询收起、退成图标，这时悬停或聚焦用提示说出名字；
 * 不带字就是图标按钮，悬停或聚焦总是提示名字。被挡住时置灰（aria-disabled），悬停、聚焦、点按说原因。
 * 收起的阈值只写在 storyboard.css 的「舞台工具条」一节。 */

import type { ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { BlockedReason } from './blocked-reason'
import { useCollapsedTextHint } from './use-collapsed-text-hint'
import { STAGE_ACTION_TEXT, stageActionClass } from './workbench-control'

type StageActionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> & {
  icon: IconName
  /** 可访问名称，提示里说的也是它。 */
  label: string
  /** 可见文字，须是 `label` 的一部分；不给就是图标按钮。 */
  text?: string | undefined
  /** 被挡住的原因；有值时置灰，点了不调 `onClick`。 */
  blocker?: string | undefined
}

/** 工具条在舞台顶部，提示往下弹，不盖到顶栏。 */
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
    // 图标按钮总是提示；带字的只在文字收起时提示，不重复念一遍看得见的字。
    <TooltipRoot {...(text === undefined ? {} : tooltip)}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={TOOLTIP_SIDE}>{label}</TooltipContent>
    </TooltipRoot>
  )
}
