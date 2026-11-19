import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'

type PickerOption = { label: string; value: string }

type OptionPickerProps = {
  /** 无障碍名称的前半，例如「小王的角色」；后面接当前选中的项。 */
  label: string
  options: readonly PickerOption[]
  value: string
  /** `value` 不在 `options` 里时显示的文字。 */
  placeholder: string
  onChange: (value: string) => void
  /** 暂时不能操作（例如正在保存），不给原因。 */
  disabled?: boolean
  /** 给了就不能操作，并用悬停提示说明原因。 */
  disabledReason?: string | undefined
}

const TRIGGER_CLASS =
  'inline-flex h-(--control-height-compact) w-28 min-w-0 ui-state cursor-pointer items-center justify-between gap-1.5 rounded-sm border border-input-border px-2.5 text-body-sm text-on-surface ui-focus disabled:cursor-not-allowed disabled:text-disabled-text aria-disabled:cursor-not-allowed aria-disabled:text-disabled-text data-[state=open]:border-on-surface'

/** 行内的单选下拉：触发按钮显示当前项，点开是锚定在它下面的单选菜单。 */
export function OptionPicker({
  disabled = false,
  disabledReason,
  label,
  onChange,
  options,
  placeholder,
  value,
}: OptionPickerProps) {
  const shown = options.find((option) => option.value === value)?.label ?? placeholder
  const face = (
    <>
      <span className="min-w-0 truncate">{shown}</span>
      <Icon className="shrink-0 text-on-surface-faint" decorative name="expand" size="sm" />
    </>
  )

  if (disabledReason !== undefined) {
    return (
      <ExplainedDisabledTrigger label={`${label}：${shown}`} reason={disabledReason} face={face} />
    )
  }

  return (
    <MenuRoot>
      <MenuTrigger aria-label={`${label}：${shown}`} className={TRIGGER_CLASS} disabled={disabled}>
        {face}
      </MenuTrigger>
      <MenuSurface align="end" className="min-w-(--radix-dropdown-menu-trigger-width)">
        <MenuRadioGroup onValueChange={onChange} value={value}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              <span className="min-w-0 truncate">{option.label}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}

function ExplainedDisabledTrigger({
  face,
  label,
  reason,
}: {
  face: ReactNode
  label: string
  reason: string
}) {
  const { rootProps, triggerProps } = useTabTooltip()
  return (
    <TooltipRoot {...rootProps}>
      <TooltipTrigger asChild {...triggerProps}>
        {/* aria-disabled 而不是 disabled：按钮还要能悬停和聚焦，才看得到原因 */}
        <button aria-disabled="true" aria-label={label} className={TRIGGER_CLASS} type="button">
          {face}
        </button>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </TooltipRoot>
  )
}
