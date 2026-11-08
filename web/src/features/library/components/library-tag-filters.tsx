import { cn } from '@/shared/lib/utils'
import { MultiPickerFilter } from '@/shared/ui/filter-bar'
import {
  dimensionEntriesOf,
  replaceDimensionTags,
  tagOptionsOf,
  type TagCountKey,
  type TagIndex,
} from '../library-tags'

const SEARCHABLE_FROM = 12

type LibraryTagFiltersProps = {
  index: TagIndex
  countKey: TagCountKey
  value: readonly string[]
  onChange: (tags: string[]) => void
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
    const nested = options.some((option) => option.group)
    return (
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
        width={cn(nested ? 'w-80' : 'w-65', 'max-w-[calc(100vw-24px)]')}
      />
    )
  })
}
