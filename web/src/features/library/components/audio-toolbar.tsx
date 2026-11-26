import type { ReactNode } from 'react'
import {
  AUDIO_FILTER_VALUES,
  AUDIO_KIND_FILTERS,
  AUDIO_KINDS,
  type AudioFilterKey,
} from '@/shared/api/reference-audios'
import { AUDIO_FILTER_LABELS, AUDIO_KIND_LABELS, audioFilterOptions } from '@/shared/ui/audition'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { FilterBarRoot, SelectFilter } from '@/shared/ui/filter-bar'
import {
  useReferenceAudioFilters,
  type ReferenceAudioScope,
  type ReferenceAudioTab,
} from '../reference-audios.api'

const TABS: readonly ReferenceAudioTab[] = [...AUDIO_KINDS, 'all']

const TAB_LABELS: Readonly<Record<ReferenceAudioTab, string>> = {
  ...AUDIO_KIND_LABELS,
  all: '全部',
}

type AudioToolbarProps = {
  scope: ReferenceAudioScope
  onScopeChange: (next: ReferenceAudioScope) => void
  /** 右边的条数说明。 */
  summary: ReactNode
}

/** 音频库的工具行：子类切换（带条数）、当前子类的属性筛选（每项选一个）和右边的条数。 */
export function AudioToolbar({ scope, onScopeChange, summary }: AudioToolbarProps) {
  const filters = useReferenceAudioFilters()
  const countOf = (tab: ReferenceAudioTab) => {
    const kinds = filters.data?.audioKinds
    if (kinds === undefined) return undefined
    return kinds
      .filter((each) => tab === 'all' || each.audioKind === tab)
      .reduce((sum, each) => sum + each.count, 0)
  }
  const traitKeys: readonly AudioFilterKey[] =
    scope.kind === 'all' ? [] : AUDIO_KIND_FILTERS[scope.kind]
  return (
    <FilterBarRoot className="gap-x-1 gap-y-2">
      <ChipGroup
        aria-label="音频类型"
        onValueChange={(value) => {
          const kind = TABS.find((each) => each === value)
          // 切换子类时清掉属性筛选，关键词留着
          if (kind !== undefined) onScopeChange({ kind, q: scope.q, traits: {} })
        }}
        type="single"
        value={scope.kind}
        variant="segmented"
      >
        {TABS.map((tab) => {
          const count = countOf(tab)
          return (
            <FilterChip className="gap-1.5 px-3" key={tab} value={tab} variant="segmented">
              {TAB_LABELS[tab]}
              {count === undefined ? null : (
                <span className="font-normal text-on-surface-faint tabular-nums">{count}</span>
              )}
            </FilterChip>
          )
        })}
      </ChipGroup>
      {traitKeys.length === 0 ? null : <span aria-hidden className="mx-2 h-4 w-px bg-hairline" />}
      {traitKeys.map((key) => (
        <SelectFilter
          className="h-8 rounded-sm px-2.5"
          id={key}
          key={key}
          noun={AUDIO_FILTER_LABELS[key].name}
          onChange={(picked) =>
            onScopeChange({
              ...scope,
              traits: {
                ...scope.traits,
                [key]: AUDIO_FILTER_VALUES[key].find((value) => value === picked),
              },
            })
          }
          options={audioFilterOptions(key)}
          value={scope.traits[key]}
          width="w-48"
        />
      ))}
      <span className="ml-auto pl-2 text-body-sm text-on-surface-faint">{summary}</span>
    </FilterBarRoot>
  )
}
