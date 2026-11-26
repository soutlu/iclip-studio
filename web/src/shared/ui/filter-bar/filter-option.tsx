import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

/** 筛选弹层里的一项：`depth` 是缩进层级，`group` 是分组标题行（加粗）。 */
export type FilterOption = {
  id: string
  label: string
  description?: string | undefined
  count?: number | undefined
  depth?: number | undefined
  group?: boolean | undefined
}

/** 筛选弹层里一行的样子，单选和多选共用；选中的行另加 `bg-state-active`。 */
export const FILTER_ROW_CLASS =
  'flex w-full ui-state cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 text-left text-body-sm text-on-surface ui-focus'

/** 一行的内容：选中时打 ✓、名字加粗，下面是说明，右边是条数。 */
export function FilterOptionContent({
  option,
  selected,
}: {
  option: FilterOption
  selected: boolean
}) {
  return (
    <>
      <span
        className={cn(
          'grid size-(--icon-sm) shrink-0 place-items-center pt-0.5',
          option.depth === 1 && 'ml-4',
          option.depth === 2 && 'ml-8',
        )}
      >
        {selected ? <Icon decorative name="check" size="sm" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', (selected || option.group) && 'font-medium')}>
          {option.label}
        </span>
        {option.description === undefined ? null : (
          <span className="mt-0.5 block text-caption text-on-surface-faint">
            {option.description}
          </span>
        )}
      </span>
      {option.count === undefined ? null : (
        <span className="shrink-0 pt-0.5 text-caption text-on-surface-faint tabular-nums">
          {option.count}
        </span>
      )}
    </>
  )
}
