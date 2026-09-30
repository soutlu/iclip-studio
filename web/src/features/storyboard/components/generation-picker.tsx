/** 出片栏上的单选器（模型、画幅共用）：按钮显示当前值，点开在按钮上方弹出单选菜单。
 * 出片栏贴着工作台底边，菜单向上展开，箭头也朝上；菜单挂在 portal 里，不会被参数行的横向滚动裁掉。
 * 外观见 storyboard.css 的出片栏一节。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

export type GenerationPickerOption = {
  /** 选项的值，也是选项上显示的字。 */
  value: string
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
  /** 按钮左侧的图标或图形。 */
  leading: ReactNode
  options: readonly GenerationPickerOption[]
  disabled: boolean
  onChange: (value: string) => void
  /** 挂在按钮上的类，给各档宽度下的尺寸规则用。 */
  className?: string
}

export function GenerationPicker({
  className,
  disabled,
  label,
  leading,
  onChange,
  options,
  text,
  value,
}: GenerationPickerProps) {
  return (
    <MenuRoot>
      <MenuTrigger asChild disabled={disabled}>
        <button
          aria-label={label}
          className={cn(
            'storyboard-bar-control storyboard-bar-picker ui-state ui-focus',
            className,
          )}
          // 按钮窄时文字截断，完整的字靠悬停看。
          title={text}
          type="button"
        >
          {leading}
          <span className="storyboard-bar-picker-text">{text}</span>
          <Icon className="storyboard-bar-picker-chevron" decorative name="expand" size="xs" />
        </button>
      </MenuTrigger>
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
                <span className="storyboard-bar-option-label">{option.value}</span>
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
