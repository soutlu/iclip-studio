import {
  SearchListInput,
  SearchListOptionContent,
  SearchListOptions,
  SearchListRoot,
  SearchListStatus,
  type SearchListOption,
  type SearchListOptionState,
} from '@/shared/ui/search-list'

export type PickerSource = {
  options: readonly SearchListOption[]
  isPending: boolean
  error: string | undefined
  onRetry: (() => void) | undefined
}

type SearchPickerProps = {
  source: PickerSource
  value: string | null
  selectedLabel?: string | undefined
  onChange: (value: string | null) => void
  label: string
  withAvatars?: boolean
}

export function SearchPicker({
  source,
  value,
  selectedLabel,
  onChange,
  label,
  withAvatars = false,
}: SearchPickerProps) {
  const { options, isPending, error, onRetry } = source
  const choices =
    value !== null && !options.some((option) => option.id === value)
      ? [{ id: value, label: selectedLabel?.trim() || `已选${label}` }, ...options]
      : options

  return (
    <SearchListRoot
      className="p-2.5"
      error={error}
      onSelect={(id) => onChange(id === value ? null : id)}
      options={choices}
      pending={isPending}
      value={value}
    >
      <SearchListInput label={`搜索${label}`} />
      <SearchListOptions
        label={label}
        renderOption={withAvatars ? renderOptionWithAvatar : undefined}
      />
      <SearchListStatus label={label} onRetry={onRetry} />
    </SearchListRoot>
  )
}

const renderOptionWithAvatar = (option: SearchListOption, { selected }: SearchListOptionState) => (
  <SearchListOptionContent
    leading={
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-label"
      >
        {Array.from(option.label.trim())[0]?.toLocaleUpperCase()}
      </span>
    }
    option={option}
    selected={selected}
  />
)
