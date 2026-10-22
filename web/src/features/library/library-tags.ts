/** 资料库标签树的查找：按树的先后排标签名、按维度拆分与替换一条的标签、把维度摊平成候选。
 * 灵感库与以后的爆款素材库共用，语义见 contract/conventions.md §15。 */

import type { LibraryTagOut, LibraryTagsOut } from '@/shared/api/generated/types.gen'

export type LibraryTag = LibraryTagOut
export type LibraryTagTree = LibraryTagsOut
/** 条数按哪一库数：灵感库是 `references`，爆款素材库是 `hitCases`。 */
export type TagCountKey = keyof LibraryTag['counts']

/** 维度下的一个取值；`depth` 从维度的直接下级开始计为 0。 */
export type TagEntry = {
  id: string
  name: string
  dimensionId: string
  parentId: string | null
  depth: number
  /** 在整棵树里的先后，按它排标签。 */
  order: number
}

export interface TagIndex {
  /** 全部维度，按树的先后。 */
  dimensions: readonly LibraryTag[]
  /** 全部取值，不含维度本身。 */
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

/** 按树的先后排好的已知取值；树里没有的 id（如刚被删掉的）不要。 */
const entriesOf = (index: TagIndex, ids: readonly string[]): TagEntry[] =>
  ids
    .flatMap((id) => {
      const entry = index.byId.get(id)
      return entry === undefined ? [] : [entry]
    })
    .sort((a, b) => a.order - b.order)

/** 只留树里有的 id，按树的先后排。 */
export const knownTagIds = (index: TagIndex, ids: readonly string[]): string[] =>
  entriesOf(index, ids).map((entry) => entry.id)

/** 标签名按树的先后；树里没有的 id 不显示，不把 id 给人看。 */
export const tagNamesOf = (index: TagIndex, ids: readonly string[]): string[] =>
  entriesOf(index, ids).map((entry) => entry.name)

/** 一个维度上的已选取值，按树的先后。 */
export const dimensionEntriesOf = (
  index: TagIndex,
  dimensionId: string,
  ids: readonly string[],
): TagEntry[] => entriesOf(index, ids).filter((entry) => entry.dimensionId === dimensionId)

/** 把一个维度上的取值换成 `next`，其余维度不动；交回整份、按树的先后。 */
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

/** 维度摊平成候选：父级在前、后代紧随；有下级的候选 `group` 为真。说明只给维度的直接下级。 */
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
        // 更深的取值不带说明：预置说明里包含给模型看的英文名。
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

/** AI 打的维度：打标与重拆会整组重写这些维度。 */
export const isAiDimension = (dimension: LibraryTag): boolean => dimension.autoFill === 'ai'
