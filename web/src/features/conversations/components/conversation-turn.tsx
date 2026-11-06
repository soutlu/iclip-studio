import { memo, use } from 'react'
import type {
  TranscriptInteraction,
  TranscriptTask,
  TranscriptTurn,
} from '@/shared/transcript/vendor'
import { ActivityCard } from './activity-card'
import { groupActivityCards, groupTurnEntries, type TurnEntry } from './activity-group'
import { ActivityRun } from './activity-run'
import { RunFailedNotice, TurnFrame } from './turn-frame'
import { TurnActions } from './turn-actions'
import { TurnResultList } from './turn-result-list'
import { turnResults } from './turn-results'
import { UserBubble } from './user-bubble'
import { WorkbenchLinksContext } from './workbench-links'

type ConversationTurnProps = {
  turn: TranscriptTurn
  interactions: ReadonlyMap<string, TranscriptInteraction>
  toolTasks: ReadonlyMap<string, TranscriptTask>
  latest?: boolean | undefined
  onRegenerate?: ((turn: TranscriptTurn) => void) | undefined
  regenerateDisabled?: boolean | undefined
  onFork?: ((turn: TranscriptTurn) => void) | undefined
  forkDisabled?: boolean | undefined
  onEdit?: ((turn: TranscriptTurn) => void) | undefined
  editDisabled?: boolean | undefined
}

const isSettled = (turn: TranscriptTurn) => turn.state !== 'running' && turn.state !== 'queued'

export const ConversationTurn = memo(function ConversationTurn({
  editDisabled,
  forkDisabled,
  interactions,
  latest = false,
  onEdit,
  onFork,
  onRegenerate,
  regenerateDisabled,
  toolTasks,
  turn,
}: ConversationTurnProps) {
  const linked = use(WorkbenchLinksContext)
  const settled = isSettled(turn)
  const entries = turn.steps.flatMap((step) => step.frames.map((frame) => ({ frame, step })))
  const lastUserFrameIndex = entries.findLastIndex(
    ({ frame }) => frame.kind === 'text' && frame.role === 'user' && frame.taskId === undefined,
  )
  const copyText = entries
    .slice(lastUserFrameIndex + 1)
    .flatMap(({ frame }) =>
      frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim().length > 0
        ? [frame.text]
        : [],
    )
    .join('\n\n')
  const liveFrameId = settled ? undefined : turn.steps.at(-1)?.frames.at(-1)?.frameId
  const blocks = groupActivityCards(groupTurnEntries(entries))
  const results = settled ? turnResults(entries.map(({ frame }) => frame)) : []
  const edit = onEdit === undefined ? undefined : () => onEdit(turn)
  const fork = onFork === undefined ? undefined : () => onFork(turn)
  const regenerate = onRegenerate === undefined ? undefined : () => onRegenerate(turn)

  const frameOf = ({ frame }: TurnEntry) => (
    <TurnFrame
      frame={frame}
      interactions={interactions}
      key={frame.frameId}
      live={frame.frameId === liveFrameId}
      toolTasks={toolTasks}
    />
  )

  return (
    <article className="group relative flex flex-col gap-3" aria-label={`第 ${turn.ordinal} 轮`}>
      {turn.content.length > 0 ? (
        <UserBubble content={turn.content} editDisabled={editDisabled} onEdit={edit} />
      ) : null}
      {blocks.map((block) =>
        block.kind === 'entry' ? (
          frameOf(block.entry)
        ) : (
          <ActivityCard key={block.cardId}>
            {block.nodes.map((node) =>
              node.kind === 'run' ? (
                <ActivityRun
                  interactions={interactions}
                  items={node.items}
                  key={node.runId}
                  liveFrameId={liveFrameId}
                  settled={settled}
                  toolTasks={toolTasks}
                />
              ) : (
                frameOf(node.entry)
              ),
            )}
          </ActivityCard>
        ),
      )}
      {results.length === 0 || !linked ? null : <TurnResultList results={results} />}
      {settled && copyText !== '' ? (
        <TurnActions
          className={
            latest ? undefined : 'absolute inset-x-0 top-full pt-0.5 touch:static touch:pt-0'
          }
          copyText={copyText}
          endedAt={turn.endedAt}
          forkDisabled={forkDisabled}
          onFork={fork}
          onRegenerate={turn.error === undefined ? regenerate : undefined}
          regenerateDisabled={regenerateDisabled}
          revealed={latest}
          usage={turn.usage}
        />
      ) : null}
      {turn.error === undefined ? null : (
        <RunFailedNotice
          error={turn.error}
          onRetry={regenerate}
          retryDisabled={regenerateDisabled}
        />
      )}
      {turn.state === 'queued' ? (
        <p className="text-body-sm text-chat-muted-text">排队中，等待上一条完成</p>
      ) : null}
    </article>
  )
})
