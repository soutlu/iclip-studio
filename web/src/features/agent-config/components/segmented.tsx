import { RadioGroup } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode }

/**
 * 分段单选。默认按内容宽度；`block` 占满一行、各段等宽；`wrap` 占满一行、各段按文字宽度分配，
 * 一行放不下时换到下一行（每段文字始终单行）。
 */
export function Segmented<T extends string>({
  block = false,
  disabled = false,
  label,
  onValueChange,
  options,
  value,
  wrap = false,
}: {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T | null
  onValueChange: (value: T) => void
  disabled?: boolean
  block?: boolean
  wrap?: boolean
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      className={cn(
        'shrink-0 items-stretch gap-0.5 rounded-sm p-0.5 ring-1 ring-border ring-inset',
        wrap
          ? 'flex min-h-(--control-height-lg) w-full flex-wrap'
          : block
            ? 'flex h-(--control-height-lg) w-full'
            : 'inline-flex h-(--control-height-md)',
      )}
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
            wrap
              ? 'h-(--control-height-md) flex-auto justify-center whitespace-nowrap'
              : block && 'min-w-0 flex-1 justify-center',
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
