import { cn } from '@/shared/lib/utils'
import { FilterPopup, useFilterBar } from './filter-bar'
import { FILTER_ROW_CLASS, FilterOptionContent, type FilterOption } from './filter-option'

type SelectFilterProps = {
  id: string
  noun: string
  options: readonly FilterOption[]
  /** 选中的那项；undefined 是不按它筛。 */
  value: string | undefined
  onChange: (value: string | undefined) => void
  width: string
  className?: string | undefined
}

/**
 * 单选的属性筛选：素净的触发器（没选时写 `noun`，选了写那一项的名字），弹层里每行一个取值。
 * 点另一项换成它，再点选中的那项清空；选完弹层关上，焦点回到触发器。
 */
export function SelectFilter({
  id,
  noun,
  options,
  value,
  onChange,
  width,
  className,
}: SelectFilterProps) {
  const label = options.find((option) => option.id === value)?.label ?? noun

  return (
    <FilterPopup
      className={className}
      id={id}
      label={label}
      popupLabel={`选择${noun}`}
      selected={value !== undefined}
      triggerLabel={`${noun}：${label}`}
      width={width}
    >
      <RadioList noun={noun} onChange={onChange} options={options} value={value} />
    </FilterPopup>
  )
}

function RadioList({
  noun,
  options,
  value,
  onChange,
}: Pick<SelectFilterProps, 'noun' | 'options' | 'value' | 'onChange'>) {
  const { close } = useFilterBar()
  return (
    <div aria-label={noun} className="flex flex-col p-1.5" role="radiogroup">
      {options.map((option) => {
        const selected = option.id === value
        return (
          <button
            aria-checked={selected}
            className={cn(FILTER_ROW_CLASS, selected && 'bg-state-active')}
            key={option.id}
            onClick={() => {
              close()
              onChange(selected ? undefined : option.id)
            }}
            role="radio"
            type="button"
          >
            <FilterOptionContent option={option} selected={selected} />
          </button>
        )
      })}
    </div>
  )
}
