import { z } from 'zod'
import { mintUuid } from '@/shared/lib/uuid'
import type { McpService } from './mcp-connections.api'

// 发起连接的页面与回调页之间的交接：localStorage 记「这次登录是哪个服务、哪个标签页发起的」，
// 按授权地址里的 state 存取（回调页是另一个窗口，sessionStorage 不共享）；结果经同源 BroadcastChannel 发回。

/** 本标签页的标识：回调页把它带回结果里，只有发起连接的那个标签页弹「已连接」。 */
export const TAB_ID = mintUuid()

const PENDING_PREFIX = 'iclip.mcp-sign-in.'
const CHANNEL_NAME = 'iclip.mcp-sign-in'

const pendingSchema = z.object({ name: z.string(), serverId: z.string(), tabId: z.string() })

export type PendingSignIn = z.output<typeof pendingSchema>

export const signInResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  serverId: z.string(),
  tabId: z.string().nullable(),
  type: z.literal('mcp-sign-in-result'),
})

export type SignInResult = z.output<typeof signInResultSchema>

/** 记下授权地址对应的服务与发起的标签页；地址里没有 state 时无从对应，不记。 */
export const rememberSignIn = (authorizationUrl: string, service: McpService, tabId: string) => {
  const state = new URL(authorizationUrl).searchParams.get('state')
  if (state === null) return
  const pending: PendingSignIn = { name: service.name, serverId: service.serverId, tabId }
  window.localStorage.setItem(PENDING_PREFIX + state, JSON.stringify(pending))
}

export const recallSignIn = (state: string): PendingSignIn | null => {
  const raw = window.localStorage.getItem(PENDING_PREFIX + state)
  if (raw === null) return null
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const forgetSignIn = (state: string) => {
  window.localStorage.removeItem(PENDING_PREFIX + state)
}

export const openSignInChannel = () => new BroadcastChannel(CHANNEL_NAME)

export const announceSignInResult = (result: Omit<SignInResult, 'type'>) => {
  const channel = openSignInChannel()
  channel.postMessage({ ...result, type: 'mcp-sign-in-result' } satisfies SignInResult)
  channel.close()
}
