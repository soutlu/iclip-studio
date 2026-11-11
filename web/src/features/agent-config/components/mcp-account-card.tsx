import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { CONNECT_PILL, type McpConnection } from '@/shared/mcp-connections'
import { Button } from '@/shared/ui/button'
import type { McpAccount } from '../mcp-account'
import { CardGlyph, DIRECTORY_CARD } from './resource-card'

const carriesClosedScope = (connection: McpConnection, requested: readonly string[] | null) =>
  requested !== null && (connection.scopes ?? []).some((scope) => !requested.includes(scope))

/**
 * 「使用自有账户」下面我自己的账户：账户名与服务给的权限，行尾断开；连接已失效时改成重新连接，卡片下写原因。
 * 未连接且没在连接时不显示，那时的入口是「测试连接」。
 */
export function AccountCard({
  account,
  requestedScopes,
}: {
  account: McpAccount
  /** 服务现在让用户连接时申请的权限；还不知道时为 `null`。 */
  requestedScopes: readonly string[] | null
}) {
  const { connecting, connection } = account
  if (connecting)
    return (
      <Card
        action={
          <Button onClick={account.cancel} size="md" variant="ghost">
            取消
          </Button>
        }
        title={
          <>
            <Icon className="shrink-0 animate-spin" decorative name="loading" size="xs" />
            <span className="truncate">正在连接，请在新窗口中完成</span>
          </>
        }
      />
    )
  if (connection === undefined || connection.state === 'none') return null

  const invalid = connection.state === 'invalid'
  const label = invalid ? '连接已失效' : '已连接'
  return (
    <>
      <Card
        action={
          invalid ? (
            <button className={CONNECT_PILL} onClick={account.signIn} type="button">
              重新连接
            </button>
          ) : (
            <Button
              loading={account.disconnecting}
              onClick={account.disconnect}
              size="md"
              variant="outlined"
            >
              断开
            </Button>
          )
        }
        note={connection.scopes?.join(' ')}
        title={
          <>
            <span
              aria-hidden
              className={cn(
                'inline-block size-1.5 shrink-0 rounded-full',
                invalid ? 'bg-error' : 'bg-primary',
              )}
            />
            <span className="truncate">{connection.account ?? label}</span>
            {connection.account === null ? null : <span className="sr-only">{label}</span>}
          </>
        }
      />
      {invalid ? (
        <p className="mt-2 text-body-sm text-error" role="alert">
          {carriesClosedScope(connection, requestedScopes)
            ? '这个连接带有已关闭的权限，请重新连接'
            : '连接已失效，请重新连接'}
        </p>
      ) : null}
    </>
  )
}

function Card({
  action,
  note,
  title,
}: {
  title: ReactNode
  note?: string | undefined
  action: ReactNode
}) {
  return (
    <div aria-label="我的账户" className={cn(DIRECTORY_CARD, 'mt-3 bg-background')} role="group">
      <CardGlyph className="size-11" name="resource-person" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-on-surface">
          {title}
        </span>
        {note === undefined || note === '' ? null : (
          <span className="truncate text-body-sm text-on-surface-variant tabular-nums">{note}</span>
        )}
      </span>
      {action}
    </div>
  )
}
