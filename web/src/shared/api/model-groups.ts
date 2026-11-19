import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zModelGroupsOut } from '@/shared/api/generated/zod.gen'

/** 部署配置里的配置组名，按配置顺序；只在部署时改，页面里不会变。 */
export const useModelGroups = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/model-providers/groups', zModelGroupsOut, {
        fallbackErrorMessage: '读取配置组失败',
        signal,
      }),
    queryKey: ['model-providers', 'groups'],
    select: (data) => data.groups,
    staleTime: Infinity,
  })
