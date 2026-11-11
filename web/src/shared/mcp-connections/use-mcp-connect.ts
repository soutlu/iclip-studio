import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { toast } from '@/shared/ui/toast'
import {
  authorizeMcp,
  connectFailureText,
  MCP_CONNECTIONS_KEY,
  type McpService,
} from './mcp-connections.api'
import {
  openSignInChannel,
  rememberSignIn,
  signInResultSchema,
  TAB_ID,
  type SignInResult,
} from './sign-in-handoff'

const SIGN_IN_WINDOW_MS = 5 * 60_000
const CLOSED_POLL_MS = 500
const POPUP_FEATURES = 'popup,width=520,height=680'

type Flow = {
  service: McpService
  popup: Window
  poll: ReturnType<typeof setInterval>
  deadline: ReturnType<typeof setTimeout>
}

class McpConnectStore {
  private readonly flows = new Map<string, Flow>()
  // 每条失败提示各用一个新 id：sonner 关掉一个 id 后还会延后移除它，这期间用同一个 id 再建的提示会被一并移除。
  private readonly failureToasts = new Map<string, string | number>()
  private readonly listeners = new Set<() => void>()
  private channel: BroadcastChannel | null = null
  private version = 0
  private readonly queryClient: QueryClient

  constructor(queryClient: QueryClient) {
    this.queryClient = queryClient
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot = () => this.version

  isConnecting = (serverId: string) => this.flows.has(serverId)

  /** 须在点击处理里同步调用：先开窗口（异步再开会被浏览器拦截），再要授权地址。 */
  connect = (service: McpService) => {
    const running = this.flows.get(service.serverId)
    if (running !== undefined) {
      running.popup.focus()
      return
    }
    this.dismissFailure(service.serverId)
    const popup = window.open('about:blank', `iclip-connect-${service.serverId}`, POPUP_FEATURES)
    if (popup === null) {
      this.fail(service, `浏览器拦截了新窗口，无法连接 ${service.name}；请允许弹出窗口后重试`)
      return
    }
    this.listen()
    const flow: Flow = {
      deadline: setTimeout(() => this.end(service.serverId), SIGN_IN_WINDOW_MS),
      // 登录页若隔离了打开者（COOP），这里会提前读到 closed；只结束「连接中」，结果仍经频道回来。
      poll: setInterval(() => {
        if (popup.closed) this.end(service.serverId)
      }, CLOSED_POLL_MS),
      popup,
      service,
    }
    this.flows.set(service.serverId, flow)
    this.emit()
    authorizeMcp(service.serverId).then(
      ({ authorizationUrl }) => {
        if (this.flows.get(service.serverId) !== flow) return
        rememberSignIn(authorizationUrl, service, TAB_ID)
        popup.location.href = authorizationUrl
      },
      (error: unknown) => {
        if (this.flows.get(service.serverId) !== flow) return
        popup.close()
        this.end(service.serverId)
        this.fail(service, connectFailureText(error, service.name))
      },
    )
  }

  cancel = (serverId: string) => {
    this.flows.get(serverId)?.popup.close()
    this.end(serverId)
  }

  private fail(service: McpService, message: string) {
    // 要用户处理的失败不自动消失：常驻到关闭或重试。
    this.failureToasts.set(
      service.serverId,
      toast.error(message, {
        action: { label: '重试', onClick: () => this.connect(service) },
        closeButton: true,
        duration: Number.POSITIVE_INFINITY,
      }),
    )
  }

  private dismissFailure(serverId: string) {
    const id = this.failureToasts.get(serverId)
    if (id === undefined) return
    this.failureToasts.delete(serverId)
    toast.dismiss(id)
  }

  private listen() {
    if (this.channel !== null) return
    this.channel = openSignInChannel()
    this.channel.onmessage = (event: MessageEvent) => {
      const parsed = signInResultSchema.safeParse(event.data)
      if (parsed.success) this.receive(parsed.data)
    }
  }

  private receive(result: SignInResult) {
    if (result.ok) void this.queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_KEY })
    if (result.tabId !== TAB_ID) return
    if (result.ok) toast.success(`${result.name} 已连接`)
    this.end(result.serverId)
  }

  private end(serverId: string) {
    const flow = this.flows.get(serverId)
    if (flow === undefined) return
    clearInterval(flow.poll)
    clearTimeout(flow.deadline)
    this.flows.delete(serverId)
    this.emit()
  }

  private emit() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

const stores = new WeakMap<QueryClient, McpConnectStore>()

const connectStoreOf = (queryClient: QueryClient): McpConnectStore => {
  let store = stores.get(queryClient)
  if (store === undefined) {
    store = new McpConnectStore(queryClient)
    stores.set(queryClient, store)
  }
  return store
}

/**
 * 连接一个使用自有账户的服务：`connect` 在新窗口里打开服务的登录页，`isConnecting` 表示该服务的登录
 * 还在进行（新窗口未关、未超时、回调页未回报），`cancel` 关掉窗口。连接成功后重读连接并提示「X 已连接」；
 * 发起失败用常驻 Toast 提示并可重试。状态按 QueryClient 共享，页面上任何地方发起的连接都看得到。
 */
export const useMcpConnect = () => {
  const store = connectStoreOf(useQueryClient())
  useSyncExternalStore(store.subscribe, store.snapshot)
  return { cancel: store.cancel, connect: store.connect, isConnecting: store.isConnecting }
}
