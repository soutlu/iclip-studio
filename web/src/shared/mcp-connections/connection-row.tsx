import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { MenuBareItem } from '@/shared/ui/menu'
import { ResourceTile } from '@/shared/ui/resource-tile'
import { type McpConnection, useDisconnectMcp } from './mcp-connections.api'
import { useMcpConnect } from './use-mcp-connect'

/** 「连接 / 重新连接」的深色小按钮。 */
export const CONNECT_PILL =
  'inline-flex h-7 shrink-0 ui-state cursor-pointer items-center gap-1 rounded-full bg-inverse-surface px-2.5 text-body-sm font-medium text-inverse-on-surface ui-focus'

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-1.5 shrink-0 rounded-full', ok ? 'bg-primary' : 'bg-error')}
    />
  )
}

/**
 * 菜单里的一个服务：图标、名称、我在它上面的连接状态，行尾一个操作。操作按钮是菜单项，参与方向键导航；
 * 连接与重新连接会收起菜单（新窗口随即打开），断开与取消留在菜单里，好看到这一行的新状态。
 */
export function McpConnectionRow({ connection }: { connection: McpConnection }) {
  const { cancel, connect, isConnecting } = useMcpConnect()
  const disconnect = useDisconnectMcp()
  const { account, name, serverId, state } = connection

  let status: ReactNode
  let action: ReactNode
  if (isConnecting(serverId)) {
    status = (
      <>
        <Icon className="shrink-0 animate-spin" decorative name="loading" size="xs" />
        <span className="truncate">正在连接，请在新窗口中完成</span>
      </>
    )
    action = (
      <Action label={`取消连接 ${name}`} onSelect={() => cancel(serverId)} stay>
        <Button className="-mr-1" size="md" variant="ghost">
          取消
        </Button>
      </Action>
    )
  } else if (state === 'connected') {
    status = (
      <>
        <StatusDot ok />
        <span className="truncate">{account ?? '已连接'}</span>
        {account === null ? null : <span className="sr-only">已连接</span>}
      </>
    )
    action = (
      <Action label={`断开 ${name}`} onSelect={() => disconnect.mutate({ name, serverId })} stay>
        <Button className="-mr-1" loading={disconnect.isPending} size="md" variant="ghost">
          断开
        </Button>
      </Action>
    )
  } else {
    const invalid = state === 'invalid'
    const verb = invalid ? '重新连接' : '连接'
    status = (
      <>
        {invalid ? <StatusDot ok={false} /> : null}
        <span className="truncate">{invalid ? '连接已失效' : '未连接'}</span>
      </>
    )
    action = (
      <Action label={`${verb} ${name}`} onSelect={() => connect({ name, serverId })}>
        <button className={CONNECT_PILL} type="button">
          {verb}
        </button>
      </Action>
    )
  }

  return (
    <div className="flex min-h-13 min-w-0 items-center gap-3 rounded-sm px-2 py-1.5">
      <ResourceTile icon="resource-mcp" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-on-surface" title={name}>
          {name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-label text-on-surface-faint">
          {status}
        </span>
      </span>
      {action}
    </div>
  )
}

function Action({
  children,
  label,
  onSelect,
  stay = false,
}: {
  children: ReactNode
  label: string
  onSelect: () => void
  stay?: boolean
}) {
  return (
    <MenuBareItem
      aria-label={label}
      asChild
      onSelect={(event) => {
        if (stay) event.preventDefault()
        onSelect()
      }}
    >
      {children}
    </MenuBareItem>
  )
}
