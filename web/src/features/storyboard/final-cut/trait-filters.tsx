import {
  AUDIO_FILTER_VALUES,
  type AudioFilterKey,
  type AudioTraitFilter,
} from '@/shared/api/reference-audios'
import { AUDIO_FILTER_LABELS, audioFilterOptions } from '@/shared/ui/audition'
import { FilterBarRoot, MultiPickerFilter } from '@/shared/ui/filter-bar'

type TraitFiltersProps = {
  /** 按先后列出的属性。 */
  keys: readonly AudioFilterKey[]
  value: AudioTraitFilter
  onChange: (next: AudioTraitFilter) => void
  /** 右边的条数；还没读到时不显示。 */
  total: number | null | undefined
}

/** 侧栏里音频列表上方的一行属性筛选（素净的多选弹层，和资料库「音频库」同一种）加右边的条数。 */
export function TraitFilters({ keys, value, onChange, total }: TraitFiltersProps) {
  return (
    <FilterBarRoot className="wf-trait-filters">
      {keys.map((key) => (
        <MultiPickerFilter
          className="wf-trait-filter"
          id={key}
          key={key}
          noun={AUDIO_FILTER_LABELS[key].name}
          onChange={(values) =>
            onChange({
              ...value,
              [key]: AUDIO_FILTER_VALUES[key].filter((each) => values.includes(each)),
            })
          }
          options={audioFilterOptions(key)}
          value={value[key] ?? []}
          width="w-44"
        />
      ))}
      {total === undefined || total === null ? null : (
        <span className="wf-trait-count">{`${String(total)} 条`}</span>
      )}
    </FilterBarRoot>
  )
}
