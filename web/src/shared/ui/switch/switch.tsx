import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'

type SwitchProps = Omit<
  ComponentPropsWithRef<'button'>,
  'children' | 'onChange' | 'role' | 'title' | 'type'
> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /**
   * 被规则拦下的原因（如正在被引用、不满足条件）：开关保持原来的开或关的颜色，只换鼠标，
   * 悬停或按 Tab 移上去弹出原因，点击与 Enter / Space 都不切换。
   */
  blockedReason?: string | undefined
}

/**
 * 全站唯一的开关外观：开是墨色轨道，关是灰色轨道，滑块用页面底色，浅色、深色主题里两态都看得清。
 *
 * 两种不能切换的状态：`blockedReason` 是被规则拦下，用 aria-disabled（仍可聚焦，原因弹得出来），颜色不变；
 * `disabled` 是真的不可用（如保存中），用原生 disabled，整体变淡。
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
    // 提示始终挂着、只在被拦下时弹：拦与不拦切换时按钮不重建，焦点不丢。
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
