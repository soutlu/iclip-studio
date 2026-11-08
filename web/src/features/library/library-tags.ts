import type { LibraryTagOut, LibraryTagsOut } from '@/shared/api/generated/types.gen'

export type LibraryTag = LibraryTagOut
export type LibraryTagTree = LibraryTagsOut
export type TagCountKey = keyof LibraryTag['counts']

export type TagEntry = {
  id: string
  name: string
  dimensionId: string
  parentId: string | null
  depth: number
  order: number
}

export interface TagIndex {
  dimensions: readonly LibraryTag[]
  byId: ReadonlyMap<string, TagEntry>
}

export const tagIndexOf = (tree: LibraryTagTree): TagIndex => {
  const byId = new Map<string, TagEntry>()
  const visit = (
    tags: readonly LibraryTag[],
    dimensionId: string,
    parentId: string | null,
    depth: number,
  ) => {
    for (const tag of tags) {
      byId.set(tag.id, {
        depth,
        dimensionId,
        id: tag.id,
        name: tag.name,
        order: byId.size,
        parentId,
      })
      visit(tag.children, dimensionId, tag.id, depth + 1)
    }
  }
  for (const dimension of tree.dimensions) visit(dimension.children, dimension.id, null, 0)
  return { byId, dimensions: tree.dimensions }
}

const entriesOf = (index: TagIndex, ids: readonly string[]): TagEntry[] =>
  ids
    .flatMap((id) => {
      const entry = index.byId.get(id)
      return entry === undefined ? [] : [entry]
    })
    .sort((a, b) => a.order - b.order)

export const knownTagIds = (index: TagIndex, ids: readonly string[]): string[] =>
  entriesOf(index, ids).map((entry) => entry.id)

export const tagNamesOf = (index: TagIndex, ids: readonly string[]): string[] =>
  entriesOf(index, ids).map((entry) => entry.name)

export const dimensionEntriesOf = (
  index: TagIndex,
  dimensionId: string,
  ids: readonly string[],
): TagEntry[] => entriesOf(index, ids).filter((entry) => entry.dimensionId === dimensionId)

export const replaceDimensionTags = (
  index: TagIndex,
  ids: readonly string[],
  dimensionId: string,
  next: readonly string[],
): string[] =>
  knownTagIds(index, [
    ...ids.filter((id) => index.byId.get(id)?.dimensionId !== dimensionId),
    ...next.filter((id) => index.byId.get(id)?.dimensionId === dimensionId),
  ])

export type TagOption = {
  id: string
  label: string
  description: string | undefined
  depth: number
  group: boolean
  counts: LibraryTag['counts']
}

export const tagOptionsOf = (dimension: LibraryTag): TagOption[] => {
  const options: TagOption[] = []
  const visit = (tags: readonly LibraryTag[], depth: number) => {
    for (const tag of tags) {
      options.push({
        counts: tag.counts,
        depth,
        description: depth === 0 ? (tag.guide ?? undefined) : undefined,
        group: tag.children.length > 0,
        id: tag.id,
        label: tag.name,
      })
      visit(tag.children, depth + 1)
    }
  }
  visit(dimension.children, 0)
  return options
}

export const isAiDimension = (dimension: LibraryTag): boolean => dimension.autoFill === 'ai'
