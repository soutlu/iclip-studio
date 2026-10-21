/** 资料库的标签筛选：标签树里每个维度一个多选弹层，按树的先后排；两层的维度里大类可勾，小类缩进排在它下面。
 * 条数按 `countKey` 取哪一库的。灵感库与爆款素材库共用，只放在 `FilterBarRoot` 里。 */

import { cn } from '@/shared/lib/utils'
import { MultiPickerFilter } from '@/shared/ui/filter-bar'
import {
  dimensionEntriesOf,
  replaceDimensionTags,
  tagOptionsOf,
  type TagCountKey,
  type TagIndex,
} from '../library-tags'

/** 候选多到要找时才给搜索框。 */
const SEARCHABLE_FROM = 12

type LibraryTagFiltersProps = {
  /** 标签树的查找表；还没读到时不出弹层。 */
  index: TagIndex
  countKey: TagCountKey
  /** 选中的全部标签，跨维度。 */
  value: readonly string[]
  /** 交回改完的整份，按树的先后。 */
  onChange: (tags: string[]) => void
  /** 触发器外观，与同一条上的其他筛选一致。 */
  className: string
}

export function LibraryTagFilters({
  index,
  countKey,
  value,
  onChange,
  className,
}: LibraryTagFiltersProps) {
  return index.dimensions.map((dimension) => {
    if (dimension.children.length === 0) return null
    const options = tagOptionsOf(dimension).map((option) => ({
      count: option.counts[countKey],
      depth: option.depth,
      description: option.description,
      group: option.group,
      id: option.id,
      label: option.label,
    }))
    const twoLevel = options.some((option) => option.group)
    return (
      // 勾一项就重查一次，弹层留着接着勾。
      <MultiPickerFilter
        className={className}
        icon="tag"
        id={`tag-${dimension.id}`}
        key={dimension.id}
        noun={dimension.name}
        onChange={(ids) => onChange(replaceDimensionTags(index, value, dimension.id, ids))}
        options={options}
        searchable={options.length >= SEARCHABLE_FROM}
        value={dimensionEntriesOf(index, dimension.id, value).map((entry) => entry.id)}
        width={cn(twoLevel ? 'w-80' : 'w-65', 'max-w-[calc(100vw-24px)]')}
      />
    )
  })
}
