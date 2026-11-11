import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import {
  hasLivePrompts as hasLivePromptsIn,
  inFlightSettled,
  type LocalTimeline,
  unclaimed,
} from '@/shared/transcript/local-prompts'
import { useLocalPrompts } from '@/shared/transcript/use-local-prompts'
import { useTranscript } from '@/shared/transcript/use-transcript'
import type { PromptContentPart, ToolCallFrame, TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { type ComposerPart, composerParts } from '@/shared/ui/composer'
import type { McpConnectionsScope } from '@/shared/mcp-connections'
import { conversationStatusLabel } from '@/shared/ui/status-badge'
import { toast } from '@/shared/ui/toast'
import { sameContent } from '@/shared/transcript/claims'
import {
  abortPrompt,
  mintPromptId,
  partsContent,
  promptMedia,
  promptText,
  regeneratePrompt,
  steerPrompt,
  submitPrompt,
  useForkConversation,
} from '../conversations.api'
import { ApprovalCard } from './approval-card'
import { BackgroundTaskBar } from './background-task-bar'
import { ConversationComposer } from './conversation-composer'
import { ConversationTurn } from './conversation-turn'
import { LoadOlder } from './load-older'
import { useKeepPlaceOnPrepend } from './use-keep-place-on-prepend'
import { useToolTasks } from './use-tool-tasks'
import { PromptQueue } from './prompt-queue'
import { UserBubble } from './user-bubble'
import { WorkbenchLinksContext } from './workbench-links'
import { WorkingIndicator } from './working-indicator'

const STICK_THRESHOLD_PX = 80

const SCROLL_IDLE_MS = 600

const frameAwaiting = (
  turns: readonly TranscriptTurn[],
  interactionId: string,
): ToolCallFrame | undefined =>
  turns
    .flatMap((turn) => turn.steps)
    .flatMap((step) => step.frames)
    .find(
      (frame): frame is ToolCallFrame =>
        frame.kind === 'tool' && frame.approvalId === interactionId,
    )

const act = (work: Promise<void>) => {
  void work.catch((error: unknown) => {
    toast.error(errorMessageOf(error, '操作失败'))
  })
}

const hasAssistantOutput = (turn: TranscriptTurn | undefined): boolean =>
  turn?.steps.some((step) =>
    step.frames.some((frame) => {
      if (frame.kind === 'tool') return true
      if (frame.kind === 'thinking') return frame.text.trim().length > 0
      return frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim().length > 0
    }),
  ) ?? false

export type ConversationTimelineProps = {
  conversationId: string | null
  openConversation?: (() => Promise<string>) | undefined
  readOnly?: { note: string; backLink?: ReactNode } | undefined
  onForked?: ((conversationId: string) => void) | undefined
  sourceLink?: ((conversationId: string) => ReactNode) | undefined
  placeholder?: string | undefined
  overlay?: ReactNode
  inlineSendError?: boolean | undefined
  workbench?: boolean | undefined
  connections?: McpConnectionsScope | undefined
}

type EditingTurn = {
  turnId: string
  content: readonly PromptContentPart[]
}

export function ConversationTimeline({
  connections,
  conversationId,
  inlineSendError = false,
  onForked,
  openConversation,
  overlay,
  placeholder,
  readOnly,
  sourceLink,
  workbench = true,
}: ConversationTimelineProps) {
  const { loadOlder, refresh, view } = useTranscript(conversationId)
  const { state: local, store: localPrompts } = useLocalPrompts(conversationId)
  const { pending, inFlightPromptId } = local
  const [editingTurn, setEditingTurn] = useState<EditingTurn | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickingRef = useRef(true)
  const [sticking, setSticking] = useState(true)
  const scrollIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || !stickingRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [view.items, pending])

  useEffect(
    () => () => {
      if (scrollIdleRef.current !== null) clearTimeout(scrollIdleRef.current)
    },
    [],
  )

  const turns = view.items.filter((item) => item.kind === 'turn')
  const toolTasks = useToolTasks(view.tasks)
  const keepPlace = useKeepPlaceOnPrepend(scrollerRef, turns[0]?.turnId, view.loadingOlder)
  const loadEarlier = () => {
    keepPlace()
    void loadOlder().catch(() => {})
  }
  const approval = view.pendingInteractions.find(
    (interaction) => interaction.interactionKind === 'approval',
  )

  const queued = view.prompts.filter((prompt) => prompt.status === 'queued')
  const running = view.prompts.find((prompt) => prompt.status === 'running')
  const latestTurn = turns.at(-1)
  const turnActive = view.activity === 'turn'
  const timeline: LocalTimeline = { prompts: view.prompts, turnActive, turns }
  const bubbles = unclaimed(local, timeline)
  const hasLivePrompts = hasLivePromptsIn(view.prompts)
  const settled = inFlightSettled(local, timeline)
  const inFlight = inFlightPromptId !== null && !settled

  useEffect(() => {
    if (conversationId !== null && settled && inFlightPromptId !== null)
      localPrompts.settle(conversationId, inFlightPromptId)
  }, [conversationId, inFlightPromptId, localPrompts, settled])
  const working = inFlight || turnActive
  const conversationBusy = working || hasLivePrompts
  const editing =
    editingTurn !== null &&
    latestTurn?.turnId === editingTurn.turnId &&
    sameContent(latestTurn.content, editingTurn.content)
      ? editingTurn
      : null
  const retry = turnActive ? latestTurn?.steps.at(-1)?.retry : undefined
  const currentTurn =
    inFlight && !turns.some((turn) => turn.triggerPromptId === inFlightPromptId)
      ? undefined
      : latestTurn
  const awaitingApproval = approval !== undefined
  const workingLabel = awaitingApproval
    ? conversationStatusLabel('approval')
    : retry !== undefined
      ? `连接失败，正在重试（第 ${retry.nextAttempt} 次）…`
      : hasAssistantOutput(currentTurn)
        ? '工作中…'
        : '正在思考…'
  const showEmptyState = view.status === 'ready' && turns.length === 0 && bubbles.length === 0

  const dispatch = async (
    parts: readonly ComposerPart[],
    request: (
      target: string,
      promptId: string,
      content: readonly PromptContentPart[],
    ) => Promise<void>,
  ) => {
    const promptId = mintPromptId()
    const content = partsContent(parts)
    setSendError(null)
    let target = conversationId
    if (target === null) {
      if (openConversation === undefined) throw new Error('会话还没开，无法发送')
      target = await openConversation()
    }
    let startsFlight = false
    try {
      startsFlight = localPrompts.begin(target, { content, promptId }, timeline)
      await request(target, promptId, content)
    } catch (error) {
      localPrompts.rollback(target, promptId, startsFlight)
      throw error
    }
    localPrompts.accepted(target, promptId)
  }

  const send = (parts: readonly ComposerPart[]) =>
    editing === null
      ? dispatch(parts, (target, promptId, content) => submitPrompt(target, { content, promptId }))
      : dispatch(parts, async (target, promptId, content) => {
          await regeneratePrompt(target, editing.turnId, { content, promptId })
          setEditingTurn(null)
        })

  const fork = useForkConversation((forked) => {
    toast.success('已另开一个任务')
    onForked?.(forked)
  })
  const { start: startFork } = fork
  const editTurn = useCallback(
    (turn: TranscriptTurn) => setEditingTurn({ content: turn.content, turnId: turn.turnId }),
    [],
  )
  const forkTurn = useCallback(
    (turn: TranscriptTurn) => {
      if (conversationId !== null) act(startFork({ conversationId, turn: turn.ordinal }))
    },
    [conversationId, startFork],
  )
  const regenerateTurn = useCallback(
    (turn: TranscriptTurn) => {
      if (conversationId !== null) act(regeneratePrompt(conversationId, turn.turnId))
    },
    [conversationId],
  )
  const onSession = (work: (id: string) => Promise<void>) => {
    if (conversationId !== null) act(work(conversationId))
  }

  const scrollToBottom = () => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    stickingRef.current = true
    setSticking(true)
    scroller.scrollTo({ behavior: 'smooth', top: scroller.scrollHeight })
  }

  const canWrite = readOnly === undefined
  const overlaid = overlay !== undefined && overlay !== null

  return (
    <WorkbenchLinksContext value={workbench}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          aria-hidden={overlaid ? true : undefined}
          className={cn('chat-scroller min-h-0 flex-1 overflow-y-auto', overlaid && 'invisible')}
          data-testid="chat-scroller"
          onScroll={(event) => {
            const scroller = event.currentTarget
            const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
            stickingRef.current = distance <= STICK_THRESHOLD_PX
            setSticking(stickingRef.current)
            scroller.dataset['scrolling'] = 'true'
            if (scrollIdleRef.current !== null) clearTimeout(scrollIdleRef.current)
            scrollIdleRef.current = setTimeout(() => {
              delete scroller.dataset['scrolling']
            }, SCROLL_IDLE_MS)
          }}
          ref={scrollerRef}
        >
          <div
            className={cn(
              'mx-auto flex min-h-full w-full max-w-(--layout-home-read-max) flex-col gap-7 px-5 pt-4',
              showEmptyState ? 'pb-4' : 'pb-8',
            )}
          >
            {view.status === 'loading' ? (
              <p className="flex items-center gap-2 py-12 text-body-sm text-on-surface-variant">
                <Icon className="animate-spin" decorative name="loading" size="sm" />
                正在读取任务
              </p>
            ) : null}
            {view.status === 'ready' ? (
              <LoadOlder
                hasMoreOlder={view.hasMoreOlder}
                loadOlderError={view.loadOlderError}
                loadingOlder={view.loadingOlder}
                onLoad={loadEarlier}
              />
            ) : null}
            {turns.map((turn) => (
              <ConversationTurn
                editDisabled={conversationBusy}
                interactions={view.interactions}
                key={turn.turnId}
                latest={turn.turnId === latestTurn?.turnId}
                onEdit={canWrite && turn.turnId === latestTurn?.turnId ? editTurn : undefined}
                forkDisabled={conversationBusy || fork.isPending}
                onFork={onForked === undefined ? undefined : forkTurn}
                onRegenerate={
                  canWrite && turn.turnId === latestTurn?.turnId ? regenerateTurn : undefined
                }
                regenerateDisabled={conversationBusy}
                toolTasks={toolTasks}
                turn={turn}
              />
            ))}
            {bubbles.map((item) => (
              <UserBubble content={item.content} key={item.promptId} />
            ))}
            {working ? (
              <div className="self-start py-1">
                <WorkingIndicator label={workingLabel} still={awaitingApproval} />
              </div>
            ) : null}
            <PromptQueue
              canSteer={running !== undefined && approval === undefined}
              onDiscard={(promptId) => onSession((id) => abortPrompt(id, promptId))}
              onSteer={(promptId) => onSession((id) => steerPrompt(id, promptId))}
              prompts={queued.map((prompt) => ({
                media: promptMedia(prompt.content),
                promptId: prompt.promptId,
                text: promptText(prompt.content),
              }))}
              readOnly={!canWrite}
            />
            {showEmptyState ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="font-home-display text-headline-lg font-semibold text-on-surface italic">
                  iClip
                </span>
                <p className="text-body-sm text-on-surface-variant">
                  暂无消息，请在下方输入开始对话
                </p>
              </div>
            ) : null}
            {view.status === 'error' ? (
              <div className="flex flex-col items-start gap-3 py-12">
                <p className="text-body-sm text-on-surface-variant">{view.error}</p>
                <Button leadingIcon="refresh" onClick={refresh} size="md" variant="outlined">
                  重新加载
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        {overlaid ? (
          <div className="absolute inset-0 overflow-y-auto">{overlay}</div>
        ) : sticking ? null : (
          <button
            aria-label="回到底部"
            className="absolute bottom-4 left-1/2 grid size-(--control-height-sm) -translate-x-1/2 animate-in ui-state cursor-pointer place-items-center rounded-full border-[0.5px] border-chat-hairline bg-top-layer text-chat-secondary-text shadow-[var(--shadow-1)] ui-focus duration-(--dur-s) ease-(--ease-decel) fade-in slide-in-from-bottom-2"
            onClick={scrollToBottom}
            title="回到底部"
            type="button"
          >
            <Icon decorative name="to-bottom" size="sm" />
          </button>
        )}
      </div>
      <div className="relative shrink-0 px-5 pb-4">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-b from-transparent to-background"
        />
        <div className="mx-auto w-full max-w-(--layout-home-read-max)">
          {approval === undefined || conversationId === null ? null : (
            <ApprovalCard
              conversationId={conversationId}
              frame={frameAwaiting(turns, approval.interactionId)}
              interactionId={approval.interactionId}
              key={approval.interactionId}
              onRefresh={refresh}
              readOnly={!canWrite}
            />
          )}
          {view.forkedFrom === null || sourceLink === undefined ? null : (
            <p
              aria-label="分叉来源"
              className="flex items-start justify-between gap-3 rounded-lg border-[0.5px] border-chat-hairline bg-top-layer px-4 py-3 text-body-sm text-chat-secondary-text"
              role="note"
            >
              <span className="flex min-w-0 items-start gap-2">
                <span className="flex h-[1lh] shrink-0 items-center">
                  <Icon decorative name="fork" size="sm" />
                </span>
                <span className="line-clamp-2">
                  本任务从源任务第 {view.forkTurn} 轮另开。工作区与出片记录保持另开时的状态。
                </span>
              </span>
              {sourceLink(view.forkedFrom)}
            </p>
          )}
          <BackgroundTaskBar tasks={toolTasks} />
          {readOnly === undefined ? (
            <>
              {sendError === null ? null : (
                <p className="mb-2 text-body-sm text-error" role="alert">
                  {sendError}
                </p>
              )}
              <ConversationComposer
                awaitingApproval={awaitingApproval}
                busy={running !== undefined}
                connections={connections}
                contextTokens={view.contextTokens}
                editing={editing === null ? undefined : { parts: composerParts(editing.content) }}
                maxContextTokens={view.maxContextTokens}
                onCancelEdit={() => setEditingTurn(null)}
                onSend={send}
                onSendError={
                  inlineSendError
                    ? (error) => setSendError(errorMessageOf(error, '发送失败，请重试发送'))
                    : undefined
                }
                onStop={
                  running === undefined
                    ? undefined
                    : () => onSession((id) => abortPrompt(id, running.promptId))
                }
                placeholder={placeholder}
              />
            </>
          ) : (
            <p
              aria-label="只读说明"
              className="flex items-start justify-between gap-3 rounded-lg border-[0.5px] border-chat-hairline bg-top-layer px-4 py-3 text-body-sm text-chat-secondary-text"
              role="note"
            >
              <span className="flex min-w-0 items-start gap-2">
                <span className="flex h-[1lh] shrink-0 items-center">
                  <Icon decorative name="preview" size="sm" />
                </span>
                <span className="line-clamp-2">{readOnly.note}</span>
              </span>
              {readOnly.backLink}
            </p>
          )}
        </div>
      </div>
    </WorkbenchLinksContext>
  )
}
