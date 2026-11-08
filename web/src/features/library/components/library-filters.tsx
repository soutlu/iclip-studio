import { dateRangeLabel } from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DateRangeFilter, FilterBarRoot, PickerFilter, useFilterBar } from '@/shared/ui/filter-bar'
import type { PickerSource } from '@/shared/ui/search-picker'
import { isDefaultScope, type FilterScope, type Orientation } from '../library.api'

type LibraryFiltersProps<S extends FilterScope> = {
  scope: S
  onChange: (next: S) => void
  myUserName: string | null
  authors: PickerSource
  trailing?: React.ReactNode
}

const orientationOf = (value: string): Orientation | null =>
  value === 'portrait' || value === 'landscape' ? value : null

const TRIGGER_CLASS =
  'h-(--control-height-sm) rounded-full border border-chip-border bg-chip-bg px-3.5 text-body-sm'

function Divider() {
  return <span aria-hidden className="mx-1 h-4.5 w-px bg-border max-sm:hidden" />
}

export function LibraryFilters<S extends FilterScope>(props: LibraryFiltersProps<S>) {
  return (
    <FilterBarRoot className="gap-2">
      <Filters {...props} />
    </FilterBarRoot>
  )
}

function Filters<S extends FilterScope>({
  scope,
  onChange,
  myUserName,
  authors,
  trailing,
}: LibraryFiltersProps<S>) {
  const { close } = useFilterBar()
  const apply = (patch: Partial<FilterScope>) => {
    close()
    onChange({ ...scope, ...patch })
  }
  const mine = myUserName !== null && scope.userName === myUserName
  const hasOrientation = scope.orientation !== undefined

  return (
    <>
      <ChipGroup
        aria-label="范围"
        onValueChange={(value) => {
          if (value === 'all')
            apply({
              range: 'all',
              since: null,
              until: null,
              userName: null,
              ...(hasOrientation ? { orientation: null } : {}),
            })
          else if (value === 'mine') apply({ userName: myUserName })
          else if (mine) apply({ userName: null })
        }}
        type="single"
        value={isDefaultScope({ ...scope, q: '' }) ? 'all' : mine ? 'mine' : ''}
      >
        <FilterChip value="all">全部</FilterChip>
        {myUserName === null ? null : <FilterChip value="mine">我生成的</FilterChip>}
      </ChipGroup>

      <PickerFilter
        className={TRIGGER_CLASS}
        fallbackLabel={scope.userName ?? '人'}
        icon="user"
        id="user"
        noun="人"
        onChange={(userName) => apply({ userName })}
        source={authors}
        value={mine ? null : scope.userName}
        width="w-60"
        withAvatars
      />

      <Divider />

      <DateRangeFilter
        className={TRIGGER_CLASS}
        label={dateRangeLabel(scope)}
        onChange={(range) => apply(range)}
        popupLabel="选择时间范围"
        triggerLabel={`时间：${dateRangeLabel(scope)}`}
        value={scope}
      />

      {hasOrientation ? (
        <>
          <Divider />
          <ChipGroup
            aria-label="画幅"
            onValueChange={(value) => apply({ orientation: orientationOf(value) })}
            type="single"
            value={scope.orientation ?? ''}
          >
            <FilterChip value="portrait">竖版</FilterChip>
            <FilterChip value="landscape">横版</FilterChip>
          </ChipGroup>
        </>
      ) : null}

      {trailing === undefined ? null : (
        <span className="ml-auto pl-2 text-body-sm text-on-surface-faint">{trailing}</span>
      )}
    </>
  )
}
