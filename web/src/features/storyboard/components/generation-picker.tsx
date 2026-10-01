/** 生成参数的单选器：按钮显示当前值，点开在按钮上方弹出单选菜单。出片栏的模型、画幅与图片编辑器的模型、分辨率共用。
 * 两处都贴着底边，菜单向上展开，箭头也朝上；菜单挂在 portal 里，不会被参数行的横向滚动裁掉。
 * 外观见 storyboard.css 的出片栏一节。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

export type GenerationPickerOption = {
  /** 选项的值；没有 `label` 时也是选项上显示的字。 */
  value: string
  /** 选项上显示的字，值和显示名不同时给（如图片模型的 id 与名称）。 */
  label?: string
  /** 选项左侧的小图形，如画幅比例框。 */
  leading?: ReactNode
  disabled?: boolean
  /** 跟在选项后的一小段说明，如「不支持」。 */
  hint?: string | undefined
}

type GenerationPickerProps = {
  /** 可访问名，按钮与菜单共用。 */
  label: string
  value: string
  /** 按钮上显示的字：通常是当前值，清单还没到手时是占位说明。 */
  text: string
  /** 按钮左侧的图标或图形；不给就只有字。 */
  leading?: ReactNode
  options: readonly GenerationPickerOption[]
  disabled: boolean
  onChange: (value: string) => void
  /** 挂在按钮上的类，给各档宽度下的尺寸规则用。 */
  className?: string
  /** 悬停、聚焦时提示的一句说明；有它就不再用原生 title 显示按钮上的字。 */
  description?: string
  /** 当前值有问题（如画幅不被模型支持）：按钮换成错误态，`describedBy` 指向说明问题的那段字。 */
  invalid?: { describedBy: string | undefined } | undefined
}

export function GenerationPicker({
  className,
  description,
  disabled,
  invalid,
  label,
  leading,
  onChange,
  options,
  text,
  value,
}: GenerationPickerProps) {
  const trigger = (
    <MenuTrigger asChild disabled={disabled}>
      <button
        aria-label={label}
        // 只在有值时才写这个键：asChild 合并属性时子元素的键会盖掉提示自己挂的说明。
        {...(invalid?.describedBy === undefined ? {} : { 'aria-describedby': invalid.describedBy })}
        className={cn('storyboard-bar-control storyboard-bar-picker ui-state ui-focus', className)}
        data-invalid={invalid === undefined ? undefined : true}
        // 按钮窄时文字截断，完整的字靠悬停看；有说明提示时让给它，免得两层提示叠在一起。
        title={description === undefined ? text : undefined}
        type="button"
      >
        {leading}
        <span className="storyboard-bar-picker-text">{text}</span>
        <Icon className="storyboard-bar-picker-chevron" decorative name="expand" size="xs" />
      </button>
    </MenuTrigger>
  )
  return (
    <MenuRoot>
      {description === undefined ? (
        trigger
      ) : (
        <TooltipRoot>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="top">{description}</TooltipContent>
        </TooltipRoot>
      )}
      <MenuSurface
        align="start"
        aria-label={label}
        aria-labelledby={undefined}
        className="storyboard-bar-menu"
        collisionPadding={16}
        side="top"
        sideOffset={8}
      >
        <MenuRadioGroup onValueChange={onChange} value={value}>
          {options.map((option) => (
            <MenuRadioItem
              disabled={option.disabled === true}
              key={option.value}
              value={option.value}
            >
              <span className="storyboard-bar-option">
                {option.leading === undefined ? null : (
                  <span className="storyboard-bar-option-leading">{option.leading}</span>
                )}
                <span className="storyboard-bar-option-label">{option.label ?? option.value}</span>
                {option.hint === undefined ? null : (
                  <small className="storyboard-bar-option-hint">{option.hint}</small>
                )}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}
