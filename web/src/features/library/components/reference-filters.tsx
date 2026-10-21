/** 参考视频的筛选条：全部 / 我的、按人、标签树每个维度一个多选、时间；治理者在最右多一个「管理标签」开关。
 * 标签的名称、说明与条数都取自标签树。 */

import { dateRangeLabel } from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DateRangeFilter, FilterBarRoot, PickerFilter, useFilterBar } from '@/shared/ui/filter-bar'
import type { PickerSource } from '@/shared/ui/search-picker'
import type { TagIndex } from '../library-tags'
import { isDefaultReferenceScope, type ReferenceScope } from '../references.api'
import { ManageTagsToggle } from './library-tag-admin'
import { LibraryTagFilters } from './library-tag-filters'

type ReferenceFiltersProps = {
  scope: ReferenceScope
  onChange: (next: ReferenceScope) => void
  /** 当前登录账号的用户名；没有用户名的账号不显示「我的」。 */
  myUserName: string | null
  authors: PickerSource
  /** 标签树的查找表；还没读到时不出标签筛选。 */
  tags: TagIndex | undefined
  /** 右侧的计数，如「共 32 条」。 */
  trailing?: React.ReactNode
  /** 给了就在最右放「管理标签」开关（只给治理者）。 */
  manageTags?: { open: boolean; onToggle: () => void } | undefined
}

// 弹层触发器照 chip 的外形，与左右两组 chip 排在一条线上。
const TRIGGER_CLASS =
  'h-(--control-height-sm) rounded-full border border-chip-border bg-chip-bg px-3.5 text-body-sm'

/** 组与组之间的竖线；窄屏会折行，折到行首的竖线没有意义，直接不显示。 */
function Divider() {
  return <span aria-hidden className="mx-1 h-4.5 w-px bg-border max-sm:hidden" />
}

export function ReferenceFilters(props: ReferenceFiltersProps) {
  return (
    <FilterBarRoot className="gap-2">
      <Filters {...props} />
    </FilterBarRoot>
  )
}

function Filters({
  scope,
  onChange,
  myUserName,
  authors,
  tags,
  trailing,
  manageTags,
}: ReferenceFiltersProps) {
  const { close } = useFilterBar()
  const apply = (patch: Partial<ReferenceScope>) => {
    close()
    onChange({ ...scope, ...patch })
  }
  const mine = myUserName !== null && scope.userName === myUserName

  return (
    <>
      <ChipGroup
        aria-label="范围"
        onValueChange={(value) => {
          // 「全部」清掉人、时间与标签，关键词另由搜索框管；再点一次已选的 chip 等于取消。
          if (value === 'all')
            apply({ range: 'all', since: null, tags: [], until: null, userName: null })
          else if (value === 'mine') apply({ userName: myUserName })
          else if (mine) apply({ userName: null })
        }}
        type="single"
        value={isDefaultReferenceScope({ ...scope, q: '' }) ? 'all' : mine ? 'mine' : ''}
      >
        <FilterChip value="all">全部</FilterChip>
        {myUserName === null ? null : <FilterChip value="mine">我的</FilterChip>}
      </ChipGroup>

      {/* 选了自己就算「我的」，这里不重复显示。 */}
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

      {tags === undefined ? null : (
        <>
          <LibraryTagFilters
            className={TRIGGER_CLASS}
            countKey="references"
            index={tags}
            onChange={(next) => onChange({ ...scope, tags: next })}
            value={scope.tags}
          />
          <Divider />
        </>
      )}

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
