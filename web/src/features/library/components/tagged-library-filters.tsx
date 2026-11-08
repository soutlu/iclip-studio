import { dateRangeLabel } from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DateRangeFilter, FilterBarRoot, PickerFilter, useFilterBar } from '@/shared/ui/filter-bar'
import type { PickerSource } from '@/shared/ui/search-picker'
import { isDefaultLibraryTagScope, type LibraryTagScope } from '../library-tag-scope'
import type { TagCountKey, TagIndex } from '../library-tags'
import { ManageTagsToggle } from './library-tag-admin'
import { LibraryTagFilters } from './library-tag-filters'

type TaggedLibraryFiltersProps<S extends LibraryTagScope> = {
  scope: S
  onChange: (next: S) => void
  countKey: TagCountKey
  myUserName: string | null
  authors: PickerSource
  tags: TagIndex | undefined
  trailing?: React.ReactNode
  manageTags?: { open: boolean; onToggle: () => void } | undefined
}

const TRIGGER_CLASS =
  'h-(--control-height-sm) rounded-full border border-chip-border bg-chip-bg px-3.5 text-body-sm'

function Divider() {
  return <span aria-hidden className="mx-1 h-4.5 w-px bg-border max-sm:hidden" />
}

export function TaggedLibraryFilters<S extends LibraryTagScope>(
  props: TaggedLibraryFiltersProps<S>,
) {
  return (
    <FilterBarRoot className="gap-2">
      <Filters {...props} />
    </FilterBarRoot>
  )
}

function Filters<S extends LibraryTagScope>({
  scope,
  onChange,
  myUserName,
  authors,
  tags,
  trailing,
  manageTags,
  countKey,
}: TaggedLibraryFiltersProps<S>) {
  const { close } = useFilterBar()
  const apply = (patch: Partial<LibraryTagScope>) => {
    close()
    onChange({ ...scope, ...patch })
  }
  const mine = myUserName !== null && scope.userName === myUserName

  return (
    <>
      <ChipGroup
        aria-label="范围"
        onValueChange={(value) => {
          if (value === 'all')
            apply({ range: 'all', since: null, tags: [], until: null, userName: null })
          else if (value === 'mine') apply({ userName: myUserName })
          else if (mine) apply({ userName: null })
        }}
        type="single"
        value={isDefaultLibraryTagScope(scope) ? 'all' : mine ? 'mine' : ''}
      >
        <FilterChip value="all">全部</FilterChip>
        {myUserName === null ? null : <FilterChip value="mine">我的</FilterChip>}
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

      {tags?.dimensions.some((dimension) => dimension.children.length > 0) ? (
        <>
          <LibraryTagFilters
            className={TRIGGER_CLASS}
            countKey={countKey}
            index={tags}
            onChange={(next) => onChange({ ...scope, tags: next })}
            value={scope.tags}
          />
          <Divider />
        </>
      ) : null}

      <DateRangeFilter
        className={TRIGGER_CLASS}
        label={dateRangeLabel(scope)}
        onChange={(range) => apply(range)}
        popupLabel="选择时间范围"
        triggerLabel={`时间：${dateRangeLabel(scope)}`}
        value={scope}
      />

      {trailing === undefined && manageTags === undefined ? null : (
        <span className="ml-auto flex items-center gap-3 pl-2">
          {trailing === undefined ? null : (
            <span className="text-body-sm text-on-surface-faint">{trailing}</span>
          )}
          {manageTags === undefined ? null : (
            <ManageTagsToggle
              className={TRIGGER_CLASS}
              onToggle={manageTags.onToggle}
              open={manageTags.open}
            />
          )}
        </span>
      )}
    </>
  )
}
