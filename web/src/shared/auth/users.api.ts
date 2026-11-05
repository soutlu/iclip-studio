import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiFetch, errorMessageOf } from '@/shared/api/client'
import { zUsersPageOut } from '@/shared/api/generated/zod.gen'
import { drainPages } from '@/shared/api/paging'
import type { PickerSource } from '@/shared/ui/search-picker'

const USERS_DIRECTORY_KEY = ['users', 'directory'] as const

const PAGE_SIZE = 200

export interface DirectoryUser {
  id: string
  displayName: string
  username: string | null
}

export const fetchUsersDirectory = (signal?: AbortSignal): Promise<DirectoryUser[]> =>
  drainPages<DirectoryUser, number>(async (token) => {
    const pageNumber = token ?? 1
    const page = await apiFetch(`/users?page=${pageNumber}&pageSize=${PAGE_SIZE}`, zUsersPageOut, {
      fallbackErrorMessage: '读取用户名册失败',
      signal: signal ?? null,
    })
    return {
      items: page.items.map((user) => ({
        displayName: user.displayName || user.username || user.email,
        id: user.id,
        username: user.username,
      })),
      next: pageNumber < Math.ceil(page.total / PAGE_SIZE) ? pageNumber + 1 : null,
    }
  })

export const useUsersDirectory = (enabled: boolean) => {
  const query = useQuery({
    enabled,
    queryFn: ({ signal }) => fetchUsersDirectory(signal),
    queryKey: USERS_DIRECTORY_KEY,
    staleTime: 5 * 60_000,
  })
  const byId = useMemo(
    () => new Map((query.data ?? []).map((user) => [user.id, user.displayName])),
    [query.data],
  )
  const byUsername = useMemo(
    () =>
      new Map(
        (query.data ?? []).flatMap((user) =>
          user.username === null ? [] : [[user.username, user.displayName] as const],
        ),
      ),
    [query.data],
  )
  const users: readonly DirectoryUser[] = query.data ?? []
  return {
    error: query.isError ? errorMessageOf(query.error, '读取用户名册失败') : undefined,
    isPending: enabled && query.isPending,
    nameOf: (userId: string) => byId.get(userId),
    nameOfUsername: (username: string) => byUsername.get(username),
    refetch: query.refetch,
    users,
  }
}

export type UsersDirectory = ReturnType<typeof useUsersDirectory>

export const userPickerSourceOf = (
  directory: UsersDirectory,
  by: 'id' | 'username',
): PickerSource => ({
  error: directory.error,
  isPending: directory.isPending,
  onRetry: () => void directory.refetch(),
  options: directory.users.flatMap((user) => {
    const id = by === 'id' ? user.id : user.username
    return id === null ? [] : [{ id, label: user.displayName }]
  }),
})
