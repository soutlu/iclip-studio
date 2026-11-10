import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { ResourceTile } from '@/shared/ui/resource-tile'
import {
  authorizeMcp,
  completeMcp,
  connectFailureText,
  connectionErrorCode,
} from './mcp-connections.api'
import {
  announceSignInResult,
  forgetSignIn,
  recallSignIn,
  rememberSignIn,
  type PendingSignIn,
} from './sign-in-handoff'

const CLOSE_DELAY_MS = 1500

/** 服务回调带回的查询参数，原样（不做 JSON 解析）交给页面。 */
export type McpCallbackParams = {
  state: string | null
  code: string | null
  iss: string | null
  error: string | null
}

type Outcome =
  | { kind: 'working' }
  | { kind: 'connected'; name: string }
  | { kind: 'failed'; title: string; retry: boolean }

const failureOf = (pending: PendingSignIn | null): Outcome =>
  pending === null
    ? { kind: 'failed', retry: false, title: '连接失败，请回到原页面重新连接' }
    : { kind: 'failed', retry: true, title: `${pending.name} 连接失败，请重试` }

const outcomeOfError = (error: unknown, pending: PendingSignIn | null): Outcome => {
  const code = connectionErrorCode(error)
  if (code === 'mcp_sign_in_foreign')
    return {
      kind: 'failed',
      retry: false,
      title: '当前登录账号与发起连接的账号不一致，无法完成连接；请回到原页面重新连接',
    }
  if (code === 'mcp_sign_in_expired')
    return { kind: 'failed', retry: false, title: '这次连接已超时，请回到原页面重新连接' }
  return failureOf(pending)
}

// 服务没走到换码这一步：用户在服务那边拒绝（带 error），或回调缺参数。
const immediateOutcome = (params: McpCallbackParams, pending: PendingSignIn | null): Outcome => {
  if (params.error !== null) return { kind: 'failed', retry: false, title: '已取消连接' }
  if (params.state === null || params.code === null) return failureOf(pending)
  return { kind: 'working' }
}

/**
 * 服务登录完成后回到的独立页面（`/mcp/callback`）：把参数交给后端完成连接，显示结果，并通知发起连接的
 * 页面；成功后稍后自行关闭窗口，关不掉时留着「返回 iClip」。
 */
export function McpCallbackPage({ params }: { params: McpCallbackParams }) {
  const navigate = useNavigate()
  const startedRef = useRef(false)
  const [pending] = useState(() => (params.state === null ? null : recallSignIn(params.state)))
  const [outcome, setOutcome] = useState(() => immediateOutcome(params, pending))
  const [retrying, setRetrying] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(closeTimerRef.current), [])

  useEffect(() => {
    // 授权码只能用一次：重复提交会被判为过期，盖掉已经成功的结果。
    if (startedRef.current) return
    startedRef.current = true
    const { code, iss, state } = params
    if (state !== null) forgetSignIn(state)
    const reportFailure = () => {
      if (pending !== null) announceSignInResult({ ...pending, ok: false })
    }
    if (state === null || code === null || params.error !== null) {
      reportFailure()
      return
    }
    completeMcp({ code, iss, state }).then(
      (result) => {
        setOutcome({ kind: 'connected', name: result.name })
        announceSignInResult({
          name: result.name,
          ok: true,
          serverId: result.serverId,
          tabId: pending?.tabId ?? null,
        })
        closeTimerRef.current = setTimeout(() => window.close(), CLOSE_DELAY_MS)
      },
      (completeError: unknown) => {
        setOutcome(outcomeOfError(completeError, pending))
        reportFailure()
      },
    )
  }, [params, pending])

  const retry = async () => {
    if (pending === null) return
    setRetrying(true)
    try {
      const { authorizationUrl } = await authorizeMcp(pending.serverId)
      rememberSignIn(authorizationUrl, pending, pending.tabId)
      window.location.assign(authorizationUrl)
    } catch (error) {
      setOutcome({ kind: 'failed', retry: true, title: connectFailureText(error, pending.name) })
      setRetrying(false)
    }
  }

  const back = () => {
    if (window.opener === null) void navigate({ to: '/' })
    else window.close()
  }

  const title =
    outcome.kind === 'working'
      ? pending === null
        ? '正在连接'
        : `正在连接 ${pending.name}`
      : outcome.kind === 'connected'
        ? `${outcome.name} 已连接`
        : outcome.title

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-6 bg-background px-8 pb-10 text-center text-on-background">
      <LinkMark outcome={outcome.kind} />
      <div aria-live="polite" className="flex flex-col items-center gap-1.5">
        <h1 className="max-w-[calc(var(--text-title)*18.5)] text-title font-semibold text-on-surface">
          {title}
        </h1>
        {outcome.kind === 'connected' ? (
          <p className="text-body-sm text-on-surface-variant">此窗口将自动关闭</p>
        ) : null}
      </div>
      {outcome.kind === 'working' ? null : (
        <div className="flex items-center gap-2">
          {outcome.kind === 'failed' && outcome.retry ? (
            <Button loading={retrying} onClick={() => void retry()} size="md" variant="inverted">
              重试
            </Button>
          ) : null}
          <Button onClick={back} size="md" variant="outlined">
            返回 iClip
          </Button>
        </div>
      )}
    </main>
  )
}

const BADGE: Record<Outcome['kind'], { icon: IconName; className: string }> = {
  connected: { className: 'bg-primary text-on-primary', icon: 'check' },
  failed: { className: 'bg-error text-on-error', icon: 'close' },
  working: { className: 'bg-surface-container-high text-on-surface-variant', icon: 'loading' },
}

/** iClip 与服务两块图标，中间一条虚线，线上的圆章表示结果。 */
function LinkMark({ outcome }: { outcome: Outcome['kind'] }) {
  const badge = BADGE[outcome]
  return (
    <div aria-hidden className="flex items-center">
      <span className="grid size-12 shrink-0 place-items-center rounded-md bg-inverse-surface font-home-display text-title-lg font-bold text-inverse-on-surface italic">
        i
      </span>
      <span className="relative w-16 border-t-[1.5px] border-dashed border-outline-variant">
        <span
          className={cn(
            'absolute top-1/2 left-1/2 grid size-5 -translate-1/2 place-items-center rounded-full ring-4 ring-background',
            badge.className,
          )}
        >
          <Icon
            className={cn(outcome === 'working' && 'animate-spin')}
            decorative
            name={badge.icon}
            size="xs"
          />
        </span>
      </span>
      <ResourceTile className="size-12" icon="resource-mcp" tone="text-resource-connection" />
    </div>
  )
}
