import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type { UserModelGroupIn, UserPatchIn } from '@/shared/api/generated/types.gen'
import { zUserEnvelope, zUsersPageOut, type zUserOut } from '@/shared/api/generated/zod.gen'
import { drainPages } from '@/shared/api/paging'
import { USERS_QUERY_KEY_ROOT } from '@/shared/auth'

export type ManagedUser = z.output<typeof zUserOut>

const ALL_USERS_KEY = [USERS_QUERY_KEY_ROOT, 'all'] as const

const PAGE_SIZE = 200

const userPath = (id: string) => `/users/${encodeURIComponent(id)}`

/** 全部用户的完整记录（角色、配置组、部门），按接口返回的顺序。 */
export const useAllUsers = () =>
  useQuery({
    queryFn: ({ signal }) =>
      drainPages<ManagedUser, number>(async (token) => {
        const pageNumber = token ?? 1
        const page = await apiFetch(
          `/users?page=${pageNumber}&pageSize=${PAGE_SIZE}`,
          zUsersPageOut,
          { fallbackErrorMessage: '读取用户失败', signal },
        )
        return {
          items: page.items,
          next: pageNumber < Math.ceil(page.total / PAGE_SIZE) ? pageNumber + 1 : null,
        }
      }),
    queryKey: ALL_USERS_KEY,
  })

/** 改一个用户的写操作：成功后先把返回的记录写进列表，再让所有 `/users` 查询（含用户名册）失效。 */
const useUserWrite = <Variables extends { userId: string }>(
  request: (variables: Variables) => Promise<{ user: ManagedUser }>,
) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSuccess: ({ user }) => {
      queryClient.setQueryData<ManagedUser[]>(ALL_USERS_KEY, (users) =>
        users?.map((item) => (item.id === user.id ? user : item)),
      )
      return queryClient.invalidateQueries({ queryKey: [USERS_QUERY_KEY_ROOT] })
    },
  })
}

export const useSetUserRole = () =>
  useUserWrite(({ userId, role }: { userId: string; role: string }) =>
    apiFetch(userPath(userId), zUserEnvelope, {
      body: { roles: [role] } satisfies UserPatchIn,
      fallbackErrorMessage: '角色保存失败',
      method: 'PATCH',
    }),
  )

export const useSetUserModelGroup = () =>
  useUserWrite(({ userId, modelGroup }: { userId: string; modelGroup: string | null }) =>
    apiFetch(`${userPath(userId)}/model-group`, zUserEnvelope, {
      body: { modelGroup } satisfies UserModelGroupIn,
      fallbackErrorMessage: '配置组保存失败',
      method: 'PUT',
    }),
  )
