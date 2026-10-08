/** 筛选条上的多选弹层：勾一项就改一次条件，弹层留着接着勾；名词、宽度与触发器外观由各条筛选条给。 */

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

/** 一个候选：`description` 是名字下面一行说明，`count` 是右侧的条数。 */
export type MultiPickerOption = {
  id: string
  label: string
  description?: string | undefined
  count?: number | undefined
}

type MultiPickerFilterProps = {
  id: string
  icon: IconName
  /** 候选的名词：没选时的触发器文字，也是搜索框、弹层与状态文案里的叫法。 */
  noun: string
  options: readonly MultiPickerOption[]
  value: readonly string[]
  onChange: (value: string[]) => void
  /** 候选多时给搜索框；不给时每行都在 Tab 序列里，空格勾选。 */
  searchable?: boolean | undefined
  isPending?: boolean | undefined
  error?: string | undefined
  onRetry?: (() => void) | undefined
  width: string
  className?: string | undefined
}

const ROW_CLASS =
  'flex w-full ui-state cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 text-left text-body-sm text-on-surface ui-focus'

/** 触发器文字：没选是名词，选一个是它，选多个是第一个加「+n」。 */
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
  // 已选但候选里没有了（如条数归零不再列出）：仍列在最前面，留一个取消勾选的入口。
  const choices: readonly MultiPickerOption[] = [
    ...value
      .filter((selected) => !options.some((option) => option.id === selected))
      .map((selected) => ({ id: selected, label: selected })),
    ...options,
  ]
  const labelOf = (selected: string) =>
    choices.find((option) => option.id === selected)?.label ?? selected
  const label = triggerText(noun, value.map(labelOf))
  // 条件按候选的先后排，地址栏里的顺序不随勾选先后变。
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

/** 一行：左边勾、中间名字与说明、右边条数。 */
function OptionContent({ option, selected }: { option: MultiPickerOption; selected: boolean }) {
  return (
    <>
      <span className="grid size-(--icon-sm) shrink-0 place-items-center pt-0.5">
        {selected ? <Icon decorative name="check" size="sm" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', selected && 'font-medium')}>{option.label}</span>
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

/** 不带搜索的短清单：每行是一个复选框按钮，Tab 走过去，空格或回车勾选。 */
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
