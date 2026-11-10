import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { ApiError, apiFetch, errorMessageOf } from '@/shared/api/client'
import type {
  McpCheckIn,
  McpServerCreateIn,
  McpServerUpdateIn,
} from '@/shared/api/generated/types.gen'
import {
  zCheckMcpServerMcpServersServerIdCheckPostResponse,
  zCheckUnsavedMcpServerMcpServersCheckPostResponse,
  zDeleteMcpServerMcpServersServerIdDeleteResponse,
  zMcpCallbackUrlMcpServersCallbackUrlGetResponse,
  type zMcpCheckOut,
  zMcpConnectionsAffectedOut,
  zMcpServerOut,
  zMcpServersOut,
} from '@/shared/api/generated/zod.gen'

export type McpServer = z.infer<typeof zMcpServerOut>
export type McpCheck = z.infer<typeof zMcpCheckOut>
export type McpTransport = McpServer['transport']
export type McpAuthMode = McpServer['authMode']

const serverPath = (id: string) => `/mcp-servers/${encodeURIComponent(id)}`

export const mcpQueryKeys = {
  callbackUrl: ['mcp-servers', 'callback-url'] as const,
  list: ['mcp-servers', 'list'] as const,
}

export const useMcpServers = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/mcp-servers', zMcpServersOut, {
        fallbackErrorMessage: '读取 MCP 服务失败',
        signal,
      }),
    queryKey: mcpQueryKeys.list,
    select: (data) => data.items,
  })

/** 服务方登记客户端时要填的回调地址；后端没配 SSO 时为 `null`。 */
export const useMcpCallbackUrl = (enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) =>
      apiFetch('/mcp-servers:callback-url', zMcpCallbackUrlMcpServersCallbackUrlGetResponse, {
        fallbackErrorMessage: '读取回调地址失败',
        signal,
      }),
    queryKey: mcpQueryKeys.callbackUrl,
    select: (data) => data.callbackUrl,
    staleTime: Infinity,
  })

export const useCheckMcpConfig = () =>
  useMutation({
    mutationFn: (body: McpCheckIn) =>
      apiFetch('/mcp-servers/check', zCheckUnsavedMcpServerMcpServersCheckPostResponse, {
        body,
        fallbackErrorMessage: '测试连接失败',
        method: 'POST',
      }),
  })

const checkSaved = (id: string) =>
  apiFetch(`${serverPath(id)}/check`, zCheckMcpServerMcpServersServerIdCheckPostResponse, {
    fallbackErrorMessage: '测试连接失败',
    method: 'POST',
  })

/** 测试已保存的服务（使用自有账户的服务用当前管理员自己的连接），通过后服务上的工具与权限范围随之更新。 */
export const useCheckMcpServer = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: checkSaved,
    onSettled: () => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.list }),
  })
}

type SaveInput =
  | { kind: 'create'; body: McpServerCreateIn; check: boolean }
  | { kind: 'update'; id: string; body: McpServerUpdateIn; check: boolean }

export type McpSaveResult = {
  server: McpServer
  check:
    { kind: 'checked'; result: McpCheck } | { kind: 'error'; message: string } | { kind: 'skipped' }
}

/** 保存服务；`check` 为真时保存后接着测试一次已保存的服务。 */
export const useSaveMcpServer = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<McpSaveResult> => {
      const saved =
        input.kind === 'create'
          ? await apiFetch('/mcp-servers', zMcpServerOut, {
              body: input.body,
              fallbackErrorMessage: '保存失败',
              method: 'POST',
            })
          : await apiFetch(serverPath(input.id), zMcpServerOut, {
              body: input.body,
              fallbackErrorMessage: '保存失败',
              method: 'PATCH',
            })
      if (!input.check) return { check: { kind: 'skipped' }, server: saved }
      try {
        return { check: { kind: 'checked', result: await checkSaved(saved.id) }, server: saved }
      } catch (error) {
        return {
          check: { kind: 'error', message: errorMessageOf(error, '测试连接失败') },
          server: saved,
        }
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.list }),
  })
}

/** `PATCH` 因会影响已连接的用户而被拦下（`409 mcp_connections_affected`）时，受影响的人数。 */
export const affectedUsersOf = (error: unknown): number | null => {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const parsed = zMcpConnectionsAffectedOut.safeParse(error.body)
  return parsed.success && parsed.data.code === 'mcp_connections_affected'
    ? parsed.data.affectedUsers
    : null
}

export const useDeleteMcpServer = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(serverPath(id), zDeleteMcpServerMcpServersServerIdDeleteResponse, {
        fallbackErrorMessage: '删除失败',
        method: 'DELETE',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.list }),
  })
}
