import { queryOptions, useQuery } from '@tanstack/react-query'
import type { ComponentCatalog } from './composition/catalog'

export type { ComponentCatalog }

export const catalogQuery = queryOptions({
  queryKey: ['whole-film', 'component-catalog'],
  queryFn: async ({ signal }) => {
    const response = await fetch('/hyperframes/catalog.json', { signal })
    if (!response.ok) throw new Error(`组件库目录读取失败（${response.status}）`)
    return (await response.json()) as ComponentCatalog
  },
  staleTime: Infinity,
  gcTime: Infinity,
})

export const useComponentCatalog = () => useQuery(catalogQuery)

/** 查询组件库中指定 `name` 条目的封面图地址；条目不存在或无封面图时返回 `null`。 */
export const thumbnailUrl = (catalog: ComponentCatalog, name: string): string | null => {
  const thumbnail = catalog.items.find((item) => item.name === name)?.thumbnail ?? null
  return thumbnail === null ? null : `/hyperframes/${catalog.version}/thumbnails/${thumbnail}`
}
