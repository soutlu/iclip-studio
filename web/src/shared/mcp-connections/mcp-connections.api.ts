import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { ApiError, apiFetch, errorMessageOf } from '@/shared/api/client'
import {
  zAuthorizeMcpMcpConnectionsServerIdAuthorizePostResponse,
  zCompleteMcpMcpConnectionsCompletePostResponse,
  zDisconnectMcpMcpConnectionsServerIdDeleteResponse,
  zMcpConnectionsOut,
  type zMcpCompleteIn,
  type zMcpConnectionOut,
} from '@/shared/api/generated/zod.gen'
import { toast } from '@/shared/ui/toast'

export type McpConnection = z.output<typeof zMcpConnectionOut>

/** 发起或断开连接时用到的那部分：服务标识与给用户看的名称。 */
export type McpService = Pick<McpConnection, 'serverId' | 'name'>

export const MCP_CONNECTIONS_KEY = ['mcp-connections'] as const

const connectionsSchema = zMcpConnectionsOut.transform((payload) => payload.items)

const servicePath = (serverId: string) => `/mcp-connections/${encodeURIComponent(serverId)}`

/**
 * 列哪段对话运行会连的服务：已有的对话（含测试预览）给 `conversationId`，按它锁定的版本算；
 * 还没建的对话给 `agentId`，`draft` 为真时按 Agent 草稿算（测试预览用，要 `agent:manage`）。
 */
export type McpConnectionsScope =
  { conversationId: string } | { agentId: string; draft?: boolean | undefined }

const scopeQuery = (scope: McpConnectionsScope) =>
  'conversationId' in scope
    ? { conversationId: scope.conversationId }
    : { agentId: scope.agentId, ...(scope.draft === true ? { draft: 'true' } : {}) }

const readConnections = (query: Record<string, string>, signal: AbortSignal) => {
  const search = new URLSearchParams(query).toString()
  return apiFetch(`/mcp-connections${search === '' ? '' : `?${search}`}`, connectionsSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取连接失败',
    signal,
  })
}

/** 当前登录用户在这段对话会连的服务上的连接。页面打开时读一次，连接完成或断开后重读，不轮询。 */
export const useMcpConnections = (scope: McpConnectionsScope) =>
  useQuery({
    queryKey: [...MCP_CONNECTIONS_KEY, scopeQuery(scope)],
    queryFn: ({ signal }) => readConnections(scopeQuery(scope), signal),
  })

/** 当前登录用户在全部启用的、使用自有账户的服务上的连接，不按对话筛（配置服务的页面用）。 */
export const useAllMcpConnections = (enabled: boolean) =>
  useQuery({
    enabled,
    queryKey: [...MCP_CONNECTIONS_KEY, 'all'],
    queryFn: ({ signal }) => readConnections({}, signal),
  })

export const authorizeMcp = (serverId: string) =>
  apiFetch(
    `${servicePath(serverId)}/authorize`,
    zAuthorizeMcpMcpConnectionsServerIdAuthorizePostResponse,
    { fallbackErrorMessage: '连接失败', method: 'POST' },
  )

export const completeMcp = (body: z.input<typeof zMcpCompleteIn>) =>
  apiFetch('/mcp-connections/complete', zCompleteMcpMcpConnectionsCompletePostResponse, {
    body,
    fallbackErrorMessage: '连接失败',
    method: 'POST',
  })

/** 409 答复里的 `code`（见 contract/conventions.md §22「用户的连接」）。 */
export const connectionErrorCode = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined
  const body = error.body
  if (typeof body !== 'object' || body === null || !('code' in body)) return undefined
  return typeof body.code === 'string' ? body.code : undefined
}

// 服务本身没配好，用户重试也没用；后端给的说明面向管理员，不原样展示。
const NEEDS_ADMIN = new Set([
  'mcp_callback_unconfigured',
  'mcp_client_required',
  'mcp_oauth_unsupported',
])

/** 发起连接失败时给用户看的一句话；`explain` 为真时是给管理员看的，直接用后端的说明。 */
export const connectFailureText = (error: unknown, name: string, explain = false): string => {
  const retry = `${name} 连接失败，请重试`
  if (explain) return errorMessageOf(error, retry)
  return NEEDS_ADMIN.has(connectionErrorCode(error) ?? '')
    ? `${name} 尚未配置完成，无法连接；请联系管理员`
    : retry
}

/** 断开一个服务：立即生效，用 Toast 确认，并重读连接。 */
export const useDisconnectMcp = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (service: McpService) =>
      apiFetch(servicePath(service.serverId), zDisconnectMcpMcpConnectionsServerIdDeleteResponse, {
        fallbackErrorMessage: '断开失败',
        method: 'DELETE',
      }),
    onError: (_error, service) => {
      toast.error(`${service.name} 断开失败，请重试`)
    },
    onSuccess: (_data, service) => {
      toast.success(`${service.name} 已断开`)
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_KEY })
    },
  })
}
