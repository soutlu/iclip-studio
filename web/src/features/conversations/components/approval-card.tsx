import { useEffect, useRef, useState, type RefObject } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { type McpConnectionsScope, useMcpConnections } from '@/shared/mcp-connections'
import { Button } from '@/shared/ui/button'
import { isBehindModal } from '@/shared/ui/dialog'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import { respondInteraction } from '../conversations.api'
import type { ApprovalItem } from './approval-batch'
import { ApprovalItemBody } from './approval-item'
import { mcpServerIdOf } from './approval-params'
import { toolCard } from './tool-display'

type ApprovalCardProps = {
  conversationId: string
  items: readonly ApprovalItem[]
  onRefresh: () => void
  readOnly: boolean
  connections: McpConnectionsScope | undefined
}

type Decision = 'approved' | 'rejected'

type ItemState = 'pending' | Decision

const DECISION_LABELS: Record<Decision, string> = { approved: '已同意', rejected: '已拒绝' }

const DECISION_BUTTONS = [
  { approved: false, label: '拒绝', title: '拒绝 (2)', variant: 'outlined' },
  { approved: true, label: '同意', title: '同意 (1)', variant: 'inverted' },
] as const

const MCP_TITLE_SEPARATOR = ' · '

const tabLabel = ({ frame }: ApprovalItem): string => {
  const { label } = toolCard(frame?.display, frame?.view)
  if (mcpServerIdOf(frame?.name ?? '') === undefined) return label
  const cut = label.indexOf(MCP_TITLE_SEPARATOR)
  return cut === -1 ? label : label.slice(cut + MCP_TITLE_SEPARATOR.length)
}

const inEditor = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, [contenteditable="true"]') !== null

function useInViewRef(targetRef: RefObject<HTMLElement | null>): RefObject<boolean> {
  const inViewRef = useRef(false)
  useEffect(() => {
    const element = targetRef.current
    if (element === null) return
    const observer = new IntersectionObserver((entries) => {
      inViewRef.current = entries.at(-1)?.isIntersecting ?? false
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [targetRef])
  return inViewRef
}

export function ApprovalCard({
  connections,
  conversationId,
  items,
  onRefresh,
  readOnly,
}: ApprovalCardProps) {
  const cardRef = useRef<HTMLElement | null>(null)
  const inViewRef = useInViewRef(cardRef)
  const [selected, setSelected] = useState<string | null>(null)
  const [sending, setSending] = useState<{ interactionId: string; approved: boolean } | null>(null)
  const [submitted, setSubmitted] = useState<ReadonlyMap<string, Decision>>(() => new Map())

  const stateOf = (item: ApprovalItem, decisions = submitted): ItemState => {
    if (item.state === 'pending') return decisions.get(item.interactionId) ?? 'pending'
    return item.state === 'approved' ? 'approved' : 'rejected'
  }
  const current =
    items.find((item) => item.interactionId === selected) ??
    items.find((item) => stateOf(item) === 'pending') ??
    items[0]

  const respond = async (item: ApprovalItem, approved: boolean) => {
    setSending({ approved, interactionId: item.interactionId })
    try {
      await respondInteraction(conversationId, item.interactionId, approved)
      const decisions = new Map(submitted).set(
        item.interactionId,
        approved ? 'approved' : 'rejected',
      )
      setSubmitted(decisions)
      const index = items.indexOf(item)
      const next = [...items.slice(index + 1), ...items.slice(0, index)].find(
        (candidate) => stateOf(candidate, decisions) === 'pending',
      )
      if (next !== undefined) setSelected(next.interactionId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('该步骤已做出决定，无法再次提交')
        onRefresh()
      } else if (error instanceof ApiError && error.status === 404) {
        toast.error('该步骤已处理，无法再次提交')
      } else {
        toast.error(errorMessageOf(error, '提交决定失败'))
      }
    } finally {
      setSending(null)
    }
  }

  const decide = (approved: boolean) => {
    if (current === undefined || readOnly || sending !== null || stateOf(current) !== 'pending')
      return
    void respond(current, approved)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '1' && event.key !== '2') return
      const card = cardRef.current
      if (event.defaultPrevented || inEditor(event.target) || card === null) return
      if (!inViewRef.current || isBehindModal(card)) return
      decide(event.key === '1')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (current === undefined) return null

  const body = (item: ApprovalItem) => {
    const serverId = mcpServerIdOf(item.frame?.name ?? '')
    return (
      <ApprovalItemBody
        account={
          readOnly || connections === undefined || serverId === undefined ? null : (
            <ApprovalAccount scope={connections} serverId={serverId} />
          )
        }
        actions={
          <DecisionArea
            busy={sending !== null}
            onDecide={decide}
            readOnly={readOnly}
            sending={sending?.interactionId === item.interactionId ? sending.approved : null}
            state={stateOf(item)}
          />
        }
        item={item}
        single={items.length === 1}
      />
    )
  }

  return (
    <section
      aria-label="等待审批"
      className="@container animate-in overflow-clip rounded-lg border-[0.5px] border-chat-hairline bg-chat-soft-card shadow-[var(--shadow-chat-soft-card)] duration-(--dur-m) ease-(--ease-decel) fade-in slide-in-from-bottom-2"
      ref={cardRef}
    >
      {items.length === 1 ? (
        body(current)
      ) : (
        <TabsRoot onValueChange={setSelected} value={current.interactionId}>
          <div className="flex items-center justify-between gap-3 border-b-[0.5px] border-chat-hairline pr-4 pl-2">
            <TabsList aria-label="待审批的调用" className="h-(--control-height-md)">
              {items.map((item) => (
                <TabsTrigger
                  className="gap-1.5"
                  key={item.interactionId}
                  leading={<StateMark state={stateOf(item)} />}
                  value={item.interactionId}
                >
                  {tabLabel(item)}
                </TabsTrigger>
              ))}
            </TabsList>
            <span className="shrink-0 text-caption text-chat-muted-text tabular-nums">
              {items.indexOf(current) + 1} / {items.length}
            </span>
          </div>
          {items.map((item) => (
            <TabsContent key={item.interactionId} value={item.interactionId}>
              {body(item)}
            </TabsContent>
          ))}
        </TabsRoot>
      )}
    </section>
  )
}

function StateMark({ state }: { state: ItemState }) {
  if (state === 'pending')
    return (
      <span aria-label="待决定" className="size-1.5 shrink-0 rounded-full bg-warning" role="img" />
    )
  return (
    <Icon
      className={cn(
        'shrink-0',
        state === 'approved' ? 'text-chat-status-success' : 'text-chat-muted-text',
      )}
      label={DECISION_LABELS[state]}
      name={state === 'approved' ? 'check' : 'close'}
      size="sm"
    />
  )
}

function DecisionArea({
  busy,
  onDecide,
  readOnly,
  sending,
  state,
}: {
  busy: boolean
  onDecide: (approved: boolean) => void
  readOnly: boolean
  sending: boolean | null
  state: ItemState
}) {
  if (state !== 'pending')
    return (
      <p
        className={cn(
          'flex items-center gap-1 text-body-sm',
          state === 'approved' ? 'text-chat-status-success' : 'text-chat-muted-text',
        )}
      >
        <Icon decorative name={state === 'approved' ? 'check' : 'close'} size="sm" />
        {DECISION_LABELS[state]}
      </p>
    )
  if (readOnly) return <p className="text-body-sm text-chat-muted-text">等待任务属主决定</p>
  return (
    <div className="flex items-center gap-2">
      {DECISION_BUTTONS.map(({ approved, label, title, variant }) => {
        const spinning = sending === approved
        return (
          <Button
            disabled={busy}
            key={label}
            onClick={() => onDecide(approved)}
            size="md"
            title={title}
            variant={variant}
          >
            <span className={cn(spinning && 'invisible')}>{label}</span>
            {spinning ? (
              <Icon className="absolute animate-spin" label="提交中" name="loading" size="sm" />
            ) : null}
          </Button>
        )
      })}
    </div>
  )
}

function ApprovalAccount({ scope, serverId }: { scope: McpConnectionsScope; serverId: string }) {
  const { data } = useMcpConnections(scope)
  const account = data?.find((connection) => connection.serverId === serverId)?.account
  return account ? (
    <span className="block truncate text-body-sm text-chat-muted-text">{account}</span>
  ) : null
}
