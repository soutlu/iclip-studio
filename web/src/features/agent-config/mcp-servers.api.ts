/** MCP 服务的读写与试连。合同见 contract/conventions.md §22。 */

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

/** 全部已登记的 MCP 服务，按合同的先后。 */
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

/** 试一份没保存的配置，什么都不存；没通也是 200，看 `ok`。 */
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

/** 保存的结果：服务已经写进去了；随后的试连有答复（`ok` 可能为 false），或者试连请求本身出错。 */
export type McpSaveResult = {
  server: McpServer
  check: { kind: 'checked'; result: McpCheck } | { kind: 'error'; message: string }
}

/**
 * 保存配置并按存好的配置再试连一次。新建与修改都不连服务，而发布要求服务试连成功过（记在服务上的
 * `lastCheck` 与 `tools`），所以存完接着调 `/{id}/check` 把结果记下。写入失败才算保存失败；
 * 写入成功后试连请求出错（网络、5xx）不抛，交回出错原因，调用方按已保存处理。
 */
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
    // 试连结果记在服务上，答复里的服务还没有它，所以重读列表。
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.list }),
  })
}

/** 删一个服务；某个 agent 的草稿或当前版本还挂着它是 409，`detail` 列出在用的 agent。 */
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
