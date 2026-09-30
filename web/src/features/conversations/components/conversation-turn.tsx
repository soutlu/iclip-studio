/** 按 turn → step → frame 顺序渲染，连续活动由 activity-group 分组并收进活动卡，单块由 turn-frame 渲染。 */

import { memo } from 'react'
import type { TranscriptTurn } from '@/shared/transcript/vendor'
import { ActivityCard, ActivityStep } from './activity-card'
import { groupActivityCards, groupTurnEntries, type TurnEntry } from './activity-group'
import { ActivityRun } from './activity-run'
import { RunFailedNotice, TurnFrame } from './turn-frame'
import { TurnActions } from './turn-actions'
import { UserBubble } from './user-bubble'

type ConversationTurnProps = {
  turn: TranscriptTurn
  /** 最新一轮：终态栏常驻；历史轮悬停才露出。 */
  latest?: boolean | undefined
  /** 仅在末轮且对话空闲时提供重新生成回调。 */
  onRegenerate?: (() => void) | undefined
  regenerateDisabled?: boolean | undefined
  /** 每一轮都能分叉；对话在忙时由调用方置灰。 */
  onFork?: (() => void) | undefined
  forkDisabled?: boolean | undefined
  /** 仅为末轮提供修改开场输入的回调。 */
  onEdit?: (() => void) | undefined
  editDisabled?: boolean | undefined
}

const isSettled = (turn: TranscriptTurn) => turn.state !== 'running' && turn.state !== 'queued'

/** 按轮 memo，避免流式更新重渲历史轮次。 */
export const ConversationTurn = memo(function ConversationTurn({
  editDisabled,
  forkDisabled,
  latest = false,
  onEdit,
  onFork,
  onRegenerate,
  regenerateDisabled,
  turn,
}: ConversationTurnProps) {
  const settled = isSettled(turn)
  const entries = turn.steps.flatMap((step) => step.frames.map((frame) => ({ frame, step })))
  const lastUserFrameIndex = entries.findLastIndex(
    ({ frame }) => frame.kind === 'text' && frame.role === 'user',
  )
  const copyText = entries
    .slice(lastUserFrameIndex + 1)
    .flatMap(({ frame }) =>
      frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim().length > 0
        ? [frame.text]
        : [],
    )
    .join('\n\n')
  // 轮头部保存开场输入，user frame 保存运行中追加消息；live 块为未结束轮的末步末块。
  const liveFrameId = settled ? undefined : turn.steps.at(-1)?.frames.at(-1)?.frameId
  const blocks = groupActivityCards(groupTurnEntries(entries))

  const frameOf = ({ frame }: TurnEntry) => (
    <TurnFrame
      frame={frame}
      key={frame.frameId}
      live={frame.frameId === liveFrameId}
      settled={settled}
    />
  )

  return (
    // relative：历史轮的终态栏叠在本轮下方的空隙里，不占版面（见下）。
    <article className="group relative flex flex-col gap-3" aria-label={`第 ${turn.ordinal} 轮`}>
      {turn.content.length > 0 ? (
        <UserBubble content={turn.content} editDisabled={editDisabled} onEdit={onEdit} />
      ) : null}
      {blocks.map((block) =>
        block.kind === 'entry' ? (
          frameOf(block.entry)
        ) : (
          <ActivityCard key={block.cardId}>
            {block.nodes.map((node) =>
              node.kind === 'run' ? (
                <ActivityRun
                  items={node.items}
                  key={node.runId}
                  liveFrameId={liveFrameId}
                  settled={settled}
                />
              ) : (
                <ActivityStep key={node.entry.frame.frameId}>{frameOf(node.entry)}</ActivityStep>
              ),
            )}
          </ActivityCard>
        ),
      )}
      {settled && copyText !== '' ? (
        <TurnActions
          // 最新一轮常驻、占位；历史轮悬停才露出，不占位，叠在与下一轮之间的空隙里，
          // 所以列轮的容器要给轮间留出不少于这一栏高度（24px）的间距。
          className={latest ? undefined : 'absolute inset-x-0 top-full pt-0.5'}
          copyText={copyText}
          endedAt={turn.endedAt}
          forkDisabled={forkDisabled}
          onFork={onFork}
          onRegenerate={onRegenerate}
          regenerateDisabled={regenerateDisabled}
          revealed={latest}
          usage={turn.usage}
        />
      ) : null}
      {turn.error === undefined ? null : <RunFailedNotice detail={turn.error} />}
      {turn.state === 'queued' ? (
        <p className="text-body-sm text-chat-muted-text">排队中，等前一条跑完</p>
      ) : null}
    </article>
  )
})
