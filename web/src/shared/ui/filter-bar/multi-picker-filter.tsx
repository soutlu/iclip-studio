import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import {
  SearchListInput,
  SearchListOptions,
  SearchListRoot,
  SearchListStatus,
} from '@/shared/ui/search-list'
import { FilterPopup } from './filter-bar'

export type MultiPickerOption = {
  id: string
  label: string
  description?: string | undefined
  count?: number | undefined
  depth?: number | undefined
  group?: boolean | undefined
}

type MultiPickerFilterProps = {
  id: string
  icon: IconName
  noun: string
  options: readonly MultiPickerOption[]
  value: readonly string[]
  onChange: (value: string[]) => void
  searchable?: boolean | undefined
  isPending?: boolean | undefined
  error?: string | undefined
  onRetry?: (() => void) | undefined
  width: string
  className?: string | undefined
}

const ROW_CLASS =
  'flex w-full ui-state cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 text-left text-body-sm text-on-surface ui-focus'

const triggerText = (noun: string, labels: readonly string[]): string => {
  const [first] = labels
  if (first === undefined) return noun
  return labels.length === 1 ? first : `${first} +${labels.length - 1}`
}

export function MultiPickerFilter({
  id,
  icon,
  noun,
  options,
  value,
  onChange,
  searchable = false,
  isPending = false,
  error,
  onRetry,
  width,
  className,
}: MultiPickerFilterProps) {
  const choices: readonly MultiPickerOption[] = [
    ...value
      .filter((selected) => !options.some((option) => option.id === selected))
      .map((selected) => ({ id: selected, label: selected })),
    ...options,
  ]
  const labelOf = (selected: string) =>
    choices.find((option) => option.id === selected)?.label ?? selected
  const label = triggerText(noun, value.map(labelOf))
  const toggle = (picked: string) => {
    const next = value.includes(picked)
      ? value.filter((selected) => selected !== picked)
      : [...value, picked]
    onChange(choices.map((option) => option.id).filter((choice) => next.includes(choice)))
  }

  return (
    <FilterPopup
      className={className}
      icon={icon}
      id={id}
      label={label}
      popupLabel={`选择${noun}`}
      selected={value.length > 0}
      triggerLabel={`${noun}：${label}`}
      width={width}
    >
      {searchable ? (
        <SearchListRoot
          className="p-1.5"
          error={error}
          onSelect={toggle}
          options={choices}
          pending={isPending}
          value={value}
        >
          <SearchListInput label={`搜索${noun}`} />
          <SearchListOptions
            className="max-h-[min(460px,50vh)]"
            label={noun}
            renderOption={(option, { selected }) => (
              <OptionContent
                option={choices.find((choice) => choice.id === option.id) ?? option}
                selected={selected}
              />
            )}
          />
          <SearchListStatus label={noun} onRetry={onRetry} />
        </SearchListRoot>
      ) : (
        <CheckList
          error={error}
          isPending={isPending}
          noun={noun}
          onRetry={onRetry}
          onToggle={toggle}
          options={choices}
          value={value}
        />
      )}
    </FilterPopup>
  )
}

function OptionContent({ option, selected }: { option: MultiPickerOption; selected: boolean }) {
  return (
    <>
      <span
        className={cn(
          'grid size-(--icon-sm) shrink-0 place-items-center pt-0.5',
          option.depth === 1 && 'ml-4',
          option.depth === 2 && 'ml-8',
        )}
      >
        {selected ? <Icon decorative name="check" size="sm" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', (selected || option.group) && 'font-medium')}>
          {option.label}
        </span>
        {option.description === undefined ? null : (
          <span className="mt-0.5 block text-caption text-on-surface-faint">
            {option.description}
          </span>
        )}
      </span>
      {option.count === undefined ? null : (
        <span className="shrink-0 pt-0.5 text-caption text-on-surface-faint tabular-nums">
          {option.count}
        </span>
      )}
    </>
  )
}

function CheckList({
  options,
  value,
  onToggle,
  noun,
  isPending,
  error,
  onRetry,
}: {
  options: readonly MultiPickerOption[]
  value: readonly string[]
  onToggle: (id: string) => void
  noun: string
  isPending: boolean
  error: string | undefined
  onRetry: (() => void) | undefined
}) {
  let status: ReactNode = null
  if (isPending) status = `正在加载${noun}…`
  else if (error !== undefined) status = error
  else if (options.length === 0) status = `暂无可选${noun}`
  return (
    <div aria-label={noun} className="flex flex-col p-1.5" role="group">
      {options.map((option) => {
        const selected = value.includes(option.id)
        return (
          <button
            aria-checked={selected}
            className={cn(ROW_CLASS, selected && 'bg-state-active')}
            key={option.id}
            onClick={() => onToggle(option.id)}
            role="checkbox"
            type="button"
          >
            <OptionContent option={option} selected={selected} />
          </button>
        )
      })}
      {status === null ? null : (
        <div className="px-3 py-5 text-center text-body-sm" role="status">
          <p className={error === undefined ? 'text-on-surface-variant' : 'text-error'}>{status}</p>
          {error !== undefined && onRetry !== undefined ? (
            <Button className="mt-2 text-primary" onClick={onRetry} size="md" variant="ghost">
              重新加载
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
