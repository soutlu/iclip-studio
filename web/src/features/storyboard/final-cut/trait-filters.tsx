import {
  AUDIO_FILTER_VALUES,
  type AudioFilterKey,
  type AudioTraitFilter,
} from '@/shared/api/reference-audios'
import { AUDIO_FILTER_LABELS, audioFilterOptions } from '@/shared/ui/audition'
import { SelectChip } from './select-chip'

type TraitFiltersProps = {
  /** 按先后列出的属性。 */
  keys: readonly AudioFilterKey[]
  value: AudioTraitFilter
  onChange: (next: AudioTraitFilter) => void
  /** 右边的条数；不给、还没读到时不显示。 */
  total?: number | null | undefined
}

/** 侧栏里音频列表上方的一行属性筛选：每项一个筛选小块（`SelectChip`），右边可带条数。 */
export function TraitFilters({ keys, value, onChange, total }: TraitFiltersProps) {
  return (
    <div className="wf-trait-filters">
      {keys.map((key) => (
        <SelectChip
          key={key}
          noun={AUDIO_FILTER_LABELS[key].name}
          onChange={(picked) =>
            onChange({
              ...value,
              [key]: AUDIO_FILTER_VALUES[key].find((each) => each === picked),
            })
          }
          options={audioFilterOptions(key)}
          value={value[key]}
        />
      ))}
      {total === undefined || total === null ? null : (
        <span className="wf-trait-count">{`${String(total)} 条`}</span>
      )}
    </div>
  )
}
