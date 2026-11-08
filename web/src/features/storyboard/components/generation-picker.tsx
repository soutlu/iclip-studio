import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

export type GenerationPickerOption = {
  value: string
  label?: string
  leading?: ReactNode
  disabled?: boolean
  hint?: string | undefined
}

type GenerationPickerProps = {
  label: string
  value: string
  text: string
  leading?: ReactNode
  options: readonly GenerationPickerOption[]
  disabled: boolean
  onChange: (value: string) => void
  className?: string
  description?: string
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
        {...(invalid?.describedBy === undefined ? {} : { 'aria-describedby': invalid.describedBy })}
        className={cn('storyboard-bar-control storyboard-bar-picker ui-state ui-focus', className)}
        data-invalid={invalid === undefined ? undefined : true}
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
