import { RadioGroup } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode }

/** 选项不多的单选：一排分段，选中的一段浅墨底加中等字重；方向键在段间移动。 */
export function Segmented<T extends string>({
  disabled = false,
  label,
  onValueChange,
  options,
  value,
}: {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T | null
  onValueChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      className="inline-flex h-(--control-height-md) shrink-0 items-stretch gap-0.5 rounded-sm p-0.5 ring-1 ring-border ring-inset"
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next)
        if (option !== undefined) onValueChange(option.value)
      }}
      orientation="horizontal"
      value={value ?? ''}
    >
      {options.map((option) => (
        <RadioGroup.Item
          className={cn(
            'inline-flex ui-state cursor-pointer items-center gap-1.5 rounded-xs px-2.5 text-body-sm text-on-surface-variant ui-focus',
            'data-[state=checked]:bg-state-active data-[state=checked]:font-medium data-[state=checked]:text-on-surface',
          )}
          key={option.value}
          value={option.value}
        >
          {option.icon}
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
