/** 标题来自 transcript 基线与推送；侧栏拓扑仅包含各列表首页，无法覆盖全部历史对话，页头合集标签因此只在拓扑里找得到时显示。 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useUser, useUsersDirectory } from '@/shared/auth'
import {
  hasLivePrompts as hasLivePromptsIn,
  inFlightSettled,
  type LocalTimeline,
  unclaimed,
} from '@/shared/transcript/local-prompts'
import { useConversationReadOnly } from '@/shared/transcript/use-conversation-read-only'
import { useLocalPrompts } from '@/shared/transcript/use-local-prompts'
import { useSessionTitles } from '@/shared/transcript/use-session-titles'
import { useTranscript } from '@/shared/transcript/use-transcript'
import type { PromptContentPart, ToolCallFrame, TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useShellChrome } from '@/shared/shell'
import { Button, IconButton } from '@/shared/ui/button'
import { type ComposerPart, composerParts } from '@/shared/ui/composer'
import { Tag } from '@/shared/ui/tag'
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
  useCachedConversationCollection,
  useForkConversation,
} from '../conversations.api'
import { ApprovalCard } from './approval-card'
import { ConversationComposer } from './conversation-composer'
import { ConversationTurn } from './conversation-turn'
import { LoadOlder } from './load-older'
import { useKeepPlaceOnPrepend } from './use-keep-place-on-prepend'
import { PromptQueue } from './prompt-queue'
import { UserBubble } from './user-bubble'
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

/** 点了就发、失败弹一条提示的操作；放在模块级，包它的回调才能保持引用不变。 */
const act = (work: Promise<void>) => {
  void work.catch((error: unknown) => {
    toast.error(errorMessageOf(error, '操作失败'))
  })
}

/** 参考 Kimi Requesting → Working：助手正文、思考非空或存在工具块。 */
const hasAssistantOutput = (turn: TranscriptTurn | undefined): boolean =>
  turn?.steps.some((step) =>
    step.frames.some((frame) => {
      if (frame.kind === 'tool') return true
      if (frame.kind === 'thinking') return frame.text.trim().length > 0
      return frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim().length > 0
    }),
  ) ?? false

type ConversationRouteProps = {
  conversationId: string
  /** 只读说明条右侧的返回入口；去哪由路由层决定，只在只读时露出。 */
  backLink?: ReactNode
  /** 分叉成功后去副本；导航归路由层，不给回调就没有分叉入口。 */
  onForked?: (conversationId: string) => void
  /** 血缘提示里回源对话的链接，由路由层按源 id 造。 */
  sourceLink?: (conversationId: string) => ReactNode
}

/** 保留原内容用于校验末轮身份；重新生成可能复用轮号。 */
type EditingTurn = {
  turnId: string
  content: readonly PromptContentPart[]
}

export function ConversationRoute({
  conversationId,
  backLink,
  onForked,
  sourceLink,
}: ConversationRouteProps) {
  const { loadOlder, refresh, view } = useTranscript(conversationId)
  const { titleOf } = useSessionTitles()
  const title = titleOf(conversationId) ?? view.title
  // 页头的合集标签只用侧栏已经拿到的拓扑，不为它单发请求；拓扑里找不到就不显示。
  const collection = useCachedConversationCollection(conversationId)
  // 只读只发生在治理者复盘别人的或已删的对话时，名册接口也只有治理者能读。
  const readOnly = useConversationReadOnly(view)
  const { data: user } = useUser()
  const { nameOf } = useUsersDirectory(readOnly)
  const ownerName = view.ownerUserId === null ? undefined : nameOf(view.ownerUserId)
  const deleted = view.deletedAt !== null
  const readOnlyLabel = deleted ? '已删除' : '只读'
  // 治理者看自己删掉的对话也是只读；主语是自己就不写成第三人称。
  const ownMine = view.ownerUserId !== null && view.ownerUserId === user?.id
  const ownerPhrase = ownMine
    ? '自己的任务'
    : ownerName === undefined
      ? undefined
      : `${ownerName} 的任务`
  const noteSubject = ownMine ? '自己' : ownerName === undefined ? '别人' : ` ${ownerName} `
  const chrome = useShellChrome()
  // 乐观气泡与在途那一轮存在对话级的 store 里，离开页面再回来仍在，读取池也据此判断本地是否有未完成的发送。
  const { state: local, store: localPrompts } = useLocalPrompts(conversationId)
  const { pending, inFlightPromptId } = local
  const [editingTurn, setEditingTurn] = useState<EditingTurn | null>(null)

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
  const keepPlace = useKeepPlaceOnPrepend(scrollerRef, turns[0]?.turnId, view.loadingOlder)
  const loadEarlier = () => {
    keepPlace()
    // 失败由视图的 loadOlderError 呈现成「重试」，这里不再另报。
    void loadOlder().catch(() => {})
  }
  // 每次仅显示一张审批卡；其他待处理交互依次展示。
  const approval = view.pendingInteractions.find(
    (interaction) => interaction.interactionKind === 'approval',
  )

  const queued = view.prompts.filter((prompt) => prompt.status === 'queued')
  const running = view.prompts.find((prompt) => prompt.status === 'running')
  // inFlight 表示本地提交状态，turnActive 取 transcript meta；队列不参与 working 判定。
  const latestTurn = turns.at(-1)
  const turnActive = view.activity === 'turn'
  const timeline: LocalTimeline = { prompts: view.prompts, turnActive, turns }
  const bubbles = unclaimed(local, timeline)
  const hasLivePrompts = hasLivePromptsIn(view.prompts)
  const settled = inFlightSettled(local, timeline)
  const inFlight = inFlightPromptId !== null && !settled

  // 收尾在渲染时就已算进 inFlight；store 不能在渲染中写，清掉记录放到提交之后。
  useEffect(() => {
    if (settled && inFlightPromptId !== null) localPrompts.settle(conversationId, inFlightPromptId)
  }, [conversationId, inFlightPromptId, localPrompts, settled])
  const working = inFlight || turnActive
  // 重新生成仅允许空闲对话末轮；运行、排队或本地提交中均视为忙，与服务端 409 条件一致。
  const conversationBusy = working || hasLivePrompts
  // 同时核对轮号和原内容，防止末轮替换或轮号复用后继续修改旧轮。
  const editing =
    editingTurn !== null &&
    latestTurn?.turnId === editingTurn.turnId &&
    sameContent(latestTurn.content, editingTurn.content)
      ? editingTurn
      : null
  const retry = turnActive ? latestTurn?.steps.at(-1)?.retry : undefined
  // 刚发出去的那句还没有自己的轮时，末轮是上一句的，不拿它的输出当这次的进度。
  const currentTurn =
    inFlight && !turns.some((turn) => turn.triggerPromptId === inFlightPromptId)
      ? undefined
      : latestTurn
  // 卡在审批上时轮次仍算在跑，但该轮到用户了：状态行换成「等你确认」、吉祥物停住，不再像在忙。
  const awaitingApproval = approval !== undefined
  const workingLabel = awaitingApproval
    ? '等你确认'
    : retry !== undefined
      ? `没连上，正在重试（第 ${retry.nextAttempt} 次）…`
      : hasAssistantOutput(currentTurn)
        ? '工作中…'
        : '正在想…'
  const showEmptyState = view.status === 'ready' && turns.length === 0 && bubbles.length === 0

  /** 发送失败时撤销乐观气泡，输入框负责恢复内容；气泡由带同一 promptId 的轮或插话块接替。 */
  const dispatch = async (
    parts: readonly ComposerPart[],
    request: (promptId: string, content: readonly PromptContentPart[]) => Promise<void>,
  ) => {
    const promptId = mintPromptId()
    const content = partsContent(parts)
    // 挂气泡也放进 try：任何一步出错都撤回并把错误交给输入框，内容不会丢。
    let startsFlight = false
    try {
      startsFlight = localPrompts.begin(conversationId, { content, promptId }, timeline)
      await request(promptId, content)
    } catch (error) {
      localPrompts.rollback(conversationId, promptId, startsFlight)
      throw error
    }
    localPrompts.accepted(conversationId, promptId)
  }

  const send = (parts: readonly ComposerPart[]) =>
    editing === null
      ? dispatch(parts, (promptId, content) => submitPrompt(conversationId, { content, promptId }))
      : // 修改末轮后服务端会替换旧轮，新轮带的是这次的 promptId。
        dispatch(parts, async (promptId, content) => {
          await regeneratePrompt(conversationId, editing.turnId, { content, promptId })
          setEditingTurn(null)
        })

  const fork = useForkConversation((forked) => {
    toast.success('已另开一个任务')
    onForked?.(forked)
  })
  // 交给按轮 memo 的回调保持引用不变：末轮流式更新时历史轮不重渲，正文节点与其中的选区都还在。
  const { start: startFork } = fork
  const editTurn = useCallback(
    (turn: TranscriptTurn) => setEditingTurn({ content: turn.content, turnId: turn.turnId }),
    [],
  )
  const forkTurn = useCallback(
    (turn: TranscriptTurn) => act(startFork({ conversationId, turn: turn.ordinal })),
    [conversationId, startFork],
  )
  const regenerateTurn = useCallback(
    (turn: TranscriptTurn) => act(regeneratePrompt(conversationId, turn.turnId)),
    [conversationId],
  )

  const scrollToBottom = () => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    stickingRef.current = true
    setSticking(true)
    scroller.scrollTo({ behavior: 'smooth', top: scroller.scrollHeight })
  }

  return (
    // 高度钉在所在栏，使滚动限制在消息区，保持输入框和自动跟随定位稳定。
    <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header
        className={cn(
          'group/pane-header flex h-13 shrink-0 items-center gap-3 border-b-[0.5px] border-chat-hairline pr-2 pl-4',
          chrome.sidebarOverlay && 'pr-14 pl-14',
        )}
        data-pane-drag-handle
      >
        <h1 className="min-w-0 truncate text-body font-semibold text-on-surface">{title}</h1>
        {collection === undefined ? null : (
          <Tag className="max-w-40 shrink-0" title={`所属合集：${collection.name}`} variant="soft">
            <Icon decorative name="folder" size="xs" />
            <span className="truncate">{collection.name}</span>
          </Tag>
        )}
        {readOnly ? (
          <Tag className="shrink-0" variant="soft">
            <Icon decorative name="preview" size="xs" />
            {ownerPhrase === undefined ? readOnlyLabel : `${readOnlyLabel} · ${ownerPhrase}`}
          </Tag>
        ) : null}
        {chrome.chat === undefined ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 group-focus-within/pane-header:opacity-100 group-hover/pane-header:opacity-100 touch:opacity-100">
            {chrome.onSwapPanes === undefined ? null : (
              <IconButton
                label="交换对话与工作台"
                name="swap-panes"
                onClick={chrome.onSwapPanes}
                size="sm"
              />
            )}
            <IconButton
              label="折叠对话"
              name="panel-left"
              onClick={chrome.chat.onCollapse}
              size="sm"
            />
          </div>
        )}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className="chat-scroller min-h-0 flex-1 overflow-y-auto"
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
              // 轮间 28px：有悬停的设备上，历史轮悬停才露出的终态栏（24px）叠在这段空隙里，见 ConversationTurn。
              'mx-auto flex min-h-full w-full max-w-(--layout-home-read-max) flex-col gap-7 px-5 pt-4',
              // 尾部留白与下方渐隐等高：滚到底时最后一行正好停在渐隐之上。
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
                onEdit={!readOnly && turn.turnId === latestTurn?.turnId ? editTurn : undefined}
                // 分叉不写源对话，别人的、已删的都分得动，所以不受 readOnly 限制。
                forkDisabled={conversationBusy || fork.isPending}
                onFork={onForked === undefined ? undefined : forkTurn}
                onRegenerate={
                  !readOnly && turn.turnId === latestTurn?.turnId ? regenerateTurn : undefined
                }
                regenerateDisabled={conversationBusy}
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
              // 等待审批时不能向当前轮追加消息。
              canSteer={running !== undefined && approval === undefined}
              onDiscard={(promptId) => act(abortPrompt(conversationId, promptId))}
              onSteer={(promptId) => act(steerPrompt(conversationId, promptId))}
              prompts={queued.map((prompt) => ({
                media: promptMedia(prompt.content),
                promptId: prompt.promptId,
                text: promptText(prompt.content),
              }))}
              readOnly={readOnly}
            />
            {showEmptyState ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="font-home-display text-headline-lg font-semibold text-on-surface italic">
                  Cue
                </span>
                <p className="text-body-sm text-on-surface-variant">
                  还没有消息 —— 在下方输入开始对话
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
        {sticking ? null : (
          // 只有图标的圆钮：窄栏里带字的胶囊会压住正文。
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
          {approval === undefined ? null : (
            <ApprovalCard
              conversationId={conversationId}
              frame={frameAwaiting(turns, approval.interactionId)}
              interactionId={approval.interactionId}
              key={approval.interactionId}
              onRefresh={refresh}
              readOnly={readOnly}
            />
          )}
          {view.forkedFrom === null || sourceLink === undefined ? null : (
            // 说明最多折两行；图标与右侧链接对齐第一行，链接不收缩。
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
                  分叉自源任务第 {view.forkTurn} 轮。工作区与出片记录停在分叉那一刻。
                </span>
              </span>
              {sourceLink(view.forkedFrom)}
            </p>
          )}
          {readOnly ? (
            <p
              aria-label="只读说明"
              className="flex items-start justify-between gap-3 rounded-lg border-[0.5px] border-chat-hairline bg-top-layer px-4 py-3 text-body-sm text-chat-secondary-text"
              role="note"
            >
              <span className="flex min-w-0 items-start gap-2">
                <span className="flex h-[1lh] shrink-0 items-center">
                  <Icon decorative name="preview" size="sm" />
                </span>
                <span className="line-clamp-2">
                  这是{noteSubject}
                  {deleted ? '已删除的任务' : '的任务'}，只能查看
                </span>
              </span>
              {backLink}
            </p>
          ) : (
            <ConversationComposer
              awaitingApproval={awaitingApproval}
              busy={running !== undefined}
              contextTokens={view.contextTokens}
              editing={editing === null ? undefined : { parts: composerParts(editing.content) }}
              maxContextTokens={view.maxContextTokens}
              onCancelEdit={() => setEditingTurn(null)}
              onSend={send}
              onStop={
                running === undefined
                  ? undefined
                  : () => act(abortPrompt(conversationId, running.promptId))
              }
            />
          )}
        </div>
      </div>
    </main>
  )
}
