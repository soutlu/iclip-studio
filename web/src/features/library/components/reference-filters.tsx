/** 参考视频的筛选条：全部 / 我的、按人、片子类型（多选）、品类（平铺可搜多选）、时间。两组标签的名称、说明与条数都取自后端。 */

import { dateRangeLabel } from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import {
  DateRangeFilter,
  FilterBarRoot,
  MultiPickerFilter,
  PickerFilter,
  useFilterBar,
} from '@/shared/ui/filter-bar'
import type { PickerSource } from '@/shared/ui/search-picker'
import {
  CATEGORY_VALUES,
  isDefaultReferenceScope,
  VIDEO_TYPE_VALUES,
  type ReferenceFilters as ReferenceFilterOptions,
  type ReferenceScope,
} from '../references.api'

type ReferenceFiltersProps = {
  scope: ReferenceScope
  onChange: (next: ReferenceScope) => void
  /** 当前登录账号的用户名；没有用户名的账号不显示「我的」。 */
  myUserName: string | null
  authors: PickerSource
  /** 两组标签的候选；读取中或失败时弹层里给状态。 */
  options: {
    data: ReferenceFilterOptions | undefined
    isPending: boolean
    error: string | undefined
    onRetry: () => void
  }
  /** 右侧的计数，如「共 32 条」。 */
  trailing?: React.ReactNode
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
  options,
  trailing,
}: ReferenceFiltersProps) {
  const { close } = useFilterBar()
  const apply = (patch: Partial<ReferenceScope>) => {
    close()
    onChange({ ...scope, ...patch })
  }
  const mine = myUserName !== null && scope.userName === myUserName
  const pickerState = {
    error: options.error,
    isPending: options.isPending,
    onRetry: options.onRetry,
  }

  return (
    <>
      <ChipGroup
        aria-label="范围"
        onValueChange={(value) => {
          // 「全部」清掉人、时间与两组标签，关键词另由搜索框管；再点一次已选的 chip 等于取消。
          if (value === 'all')
            apply({
              categories: [],
              range: 'all',
              since: null,
              until: null,
              userName: null,
              videoTypes: [],
            })
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

      {/* 两组标签勾一项就重查一次，弹层留着接着勾。 */}
      <MultiPickerFilter
        {...pickerState}
        className={TRIGGER_CLASS}
        icon="video-type"
        id="video-type"
        noun="片子类型"
        onChange={(ids) =>
          onChange({ ...scope, videoTypes: VIDEO_TYPE_VALUES.filter((type) => ids.includes(type)) })
        }
        options={(options.data?.videoTypes ?? []).map((type) => ({
          count: type.count,
          description: type.rule,
          id: type.value,
          label: type.label,
        }))}
        value={scope.videoTypes}
        width="w-80 max-w-[calc(100vw-24px)]"
      />
      <MultiPickerFilter
        {...pickerState}
        className={TRIGGER_CLASS}
        icon="tag"
        id="category"
        noun="品类"
        onChange={(ids) =>
          onChange({ ...scope, categories: CATEGORY_VALUES.filter((name) => ids.includes(name)) })
        }
        options={(options.data?.categories ?? []).map((category) => ({
          count: category.count,
          id: category.name,
          label: category.name,
        }))}
        searchable
        value={scope.categories}
        width="w-65 max-w-[calc(100vw-24px)]"
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

      {trailing === undefined ? null : (
        <span className="ml-auto pl-2 text-body-sm text-on-surface-faint">{trailing}</span>
      )}
    </>
  )
}
