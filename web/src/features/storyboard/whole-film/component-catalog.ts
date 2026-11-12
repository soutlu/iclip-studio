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
