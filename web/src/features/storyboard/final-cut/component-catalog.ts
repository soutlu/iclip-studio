import { queryOptions, useQuery } from '@tanstack/react-query'
import type { ComponentCatalog } from './composition/catalog'

export type { ComponentCatalog }

const catalogQuery = queryOptions({
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

/** 组件库里名字是 `name` 的条目的封面地址；没有这个条目或它没有封面时是 null。 */
export const thumbnailUrl = (catalog: ComponentCatalog, name: string): string | null => {
  const thumbnail = catalog.items.find((item) => item.name === name)?.thumbnail ?? null
  return thumbnail === null ? null : `/hyperframes/${catalog.version}/thumbnails/${thumbnail}`
}
