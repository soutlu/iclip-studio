import type { IconName } from '@/shared/icons'
import type { DateRange } from '@/shared/lib/date-range'
import { DateRangePicker } from '@/shared/ui/date-range-picker'
import { SearchPicker, type PickerSource } from '@/shared/ui/search-picker'
import { FilterPopup } from './filter-bar'

type PickerFilterProps = {
  id: string
  icon: IconName
  noun: string
  fallbackLabel: string
  source: PickerSource | null
  value: string | null
  onChange: (value: string | null) => void
  width: string
  className?: string | undefined
  withAvatars?: boolean | undefined
  disabledTitle?: string | undefined
}

export function PickerFilter({
  id,
  icon,
  noun,
  fallbackLabel,
  source,
  value,
  onChange,
  width,
  className,
  withAvatars,
  disabledTitle,
}: PickerFilterProps) {
  const label =
    value === null
      ? noun
      : (source?.options.find((option) => option.id === value)?.label ?? fallbackLabel)
  return (
    <FilterPopup
      className={className}
      disabled={source === null}
      icon={icon}
      id={id}
      label={label}
      popupLabel={`选择${noun}`}
      selected={value !== null}
      title={source === null ? disabledTitle : label}
      triggerLabel={`${noun}：${label}`}
      width={width}
    >
      {source === null ? null : (
        <SearchPicker
          label={noun}
          onChange={onChange}
          selectedLabel={label}
          source={source}
          value={value}
          withAvatars={withAvatars ?? false}
        />
      )}
    </FilterPopup>
  )
}

type DateRangeFilterProps = {
  value: DateRange
  onChange: (value: DateRange) => void
  label: string
  triggerLabel?: string | undefined
  popupLabel: string
  align?: 'start' | 'end' | undefined
  className?: string | undefined
}

export function DateRangeFilter({
  value,
  onChange,
  label,
  triggerLabel,
  popupLabel,
  align,
  className,
}: DateRangeFilterProps) {
  return (
    <FilterPopup
      {...(align === undefined ? {} : { align })}
      className={className}
      icon="duration"
      id="time"
      label={label}
      popupLabel={popupLabel}
      selected={value.range !== 'all'}
      triggerLabel={triggerLabel}
      width="w-max max-w-[calc(100vw-24px)] rounded-lg"
    >
      <DateRangePicker onChange={onChange} value={value} />
    </FilterPopup>
  )
}
