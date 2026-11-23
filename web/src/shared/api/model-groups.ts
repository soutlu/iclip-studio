import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zModelGroupsOut } from '@/shared/api/generated/zod.gen'

/** 部署配置中定义的模型配置组名称列表（保持配置顺序）；仅随部署变更，运行期间不修改。 */
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
