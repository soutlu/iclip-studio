import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, errorMessageOf } from '@/shared/api/client'
import type {
  McpCheckIn,
  McpServerCreateIn,
  McpServerUpdateIn,
} from '@/shared/api/generated/types.gen'
import {
  zCheckMcpServerMcpServersServerIdCheckPostResponse,
  zCheckUnsavedMcpServerMcpServersCheckPostResponse,
  zDeleteMcpServerMcpServersServerIdDeleteResponse,
  type zMcpCheckOut,
  zMcpServerOut,
  zMcpServersOut,
} from '@/shared/api/generated/zod.gen'

export type McpServer = z.infer<typeof zMcpServerOut>
export type McpCheck = z.infer<typeof zMcpCheckOut>
export type McpTransport = McpServer['transport']

const serverPath = (id: string) => `/mcp-servers/${encodeURIComponent(id)}`

export const mcpQueryKeys = {
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

export const useCheckMcpConfig = () =>
  useMutation({
    mutationFn: (body: McpCheckIn) =>
      apiFetch('/mcp-servers/check', zCheckUnsavedMcpServerMcpServersCheckPostResponse, {
        body,
        fallbackErrorMessage: '测试连接失败',
        method: 'POST',
      }),
  })

type SaveInput =
  | { kind: 'create'; body: McpServerCreateIn }
  | { kind: 'update'; id: string; body: McpServerUpdateIn }

export type McpSaveResult = {
  server: McpServer
  check: { kind: 'checked'; result: McpCheck } | { kind: 'error'; message: string }
}

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
      try {
        const result = await apiFetch(
          `${serverPath(saved.id)}/check`,
          zCheckMcpServerMcpServersServerIdCheckPostResponse,
          { fallbackErrorMessage: '测试连接失败', method: 'POST' },
        )
        return { check: { kind: 'checked', result }, server: saved }
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
