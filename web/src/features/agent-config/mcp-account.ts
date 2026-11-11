import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef } from 'react'
import { useAllMcpConnections, useDisconnectMcp, useMcpConnect } from '@/shared/mcp-connections'
import { mcpQueryKeys, type McpServer } from './mcp-servers.api'

/**
 * 当前管理员自己在一个已保存的、使用自有账户的服务上的连接，和在配置页连接、断开它的动作。
 * `connection` 在连接没读到或服务不在列表里（已停用）时为 `undefined`，`reading` 表示正在读。
 * 一次连接结束后重读服务，服务上的客户端状态与已连接人数随之更新。
 */
export const useMcpAccount = (server: McpServer | undefined) => {
  const queryClient = useQueryClient()
  const connections = useAllMcpConnections(server?.authMode === 'per_user')
  const { cancel, connect, isConnecting } = useMcpConnect()
  const disconnect = useDisconnectMcp()
  const connection =
    server === undefined ? undefined : connections.data?.find((one) => one.serverId === server.id)
  const connecting = server !== undefined && isConnecting(server.id)

  const rereadServers = () => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.list })
  const settled = useEffectEvent(() => void rereadServers())
  const wasConnectingRef = useRef(connecting)
  useEffect(() => {
    if (wasConnectingRef.current && !connecting) settled()
    wasConnectingRef.current = connecting
  }, [connecting])

  return {
    cancel: () => {
      if (server !== undefined) cancel(server.id)
    },
    connecting,
    connection,
    disconnect: () => {
      if (server === undefined) return
      disconnect.mutate(
        { name: server.name, serverId: server.id },
        { onSuccess: () => void rereadServers() },
      )
    },
    disconnecting: disconnect.isPending,
    reading: connections.isFetching,
    /** 须在点击处理里同步调用（新窗口要在点击里打开）。 */
    signIn: () => {
      if (server !== undefined)
        connect({ name: server.name, serverId: server.id }, { explain: true })
    },
  }
}

export type McpAccount = ReturnType<typeof useMcpAccount>

/** 我的连接从未连接或已失效变成已连接时调用 `onConnected`；别的标签页里连上也算。 */
export const useOnMcpConnected = (account: McpAccount, onConnected: () => void) => {
  const state = account.connection?.state
  const connected = useEffectEvent(onConnected)
  const beforeRef = useRef(state)
  useEffect(() => {
    const was = beforeRef.current
    beforeRef.current = state
    if (state === 'connected' && was !== undefined && was !== 'connected') connected()
  }, [state])
}
