import { describe, expect, it } from 'vitest'
import type {
  InteractionState,
  ToolCallFrame,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptStep,
  TranscriptTurn,
} from '@/shared/transcript/vendor'
import { approvalBatch } from './approval-batch'

const call = (frameId: string, approvalId?: string): ToolCallFrame => ({
  frameId,
  kind: 'tool',
  name: 'mcp_insights_publish',
  state: 'running',
  toolCallId: `call_${frameId}`,
  ...(approvalId === undefined ? {} : { approvalId }),
})

const step = (stepId: string, frames: TranscriptFrame[]): TranscriptStep => ({
  frames,
  kind: 'step',
  ordinal: 1,
  state: 'running',
  stepId,
  turnId: 't1',
})

const turn = (...steps: TranscriptStep[]): TranscriptTurn => ({
  content: [],
  kind: 'turn',
  ordinal: 1,
  origin: { kind: 'user' },
  state: 'running',
  steps,
  turnId: 't1',
})

const interaction = (interactionId: string, state: InteractionState): TranscriptInteraction => ({
  interactionId,
  interactionKind: 'approval',
  state,
})

const known = (...items: TranscriptInteraction[]) =>
  new Map(items.map((item) => [item.interactionId, item]))

describe('approvalBatch', () => {
  it('没有未决定的审批就没有这一批', () => {
    const decided = interaction('a1', 'approved')
    expect(approvalBatch([turn(step('s1', [call('f1', 'a1')]))], known(decided), [])).toEqual([])
  })

  it('取最近一个含未决定审批的那一步，所有带审批的调用按顺序成项，状态读交互', () => {
    const turns = [
      turn(
        step('s1', [call('old', 'a0')]),
        step('s2', [call('f1', 'a1'), call('plain'), call('f2', 'a2')]),
      ),
    ]
    const a1 = interaction('a1', 'approved')
    const a2 = interaction('a2', 'pending')

    const batch = approvalBatch(turns, known(interaction('a0', 'approved'), a1, a2), [a2])

    expect(batch.map((item) => [item.interactionId, item.frame?.frameId, item.state])).toEqual([
      ['a1', 'f1', 'approved'],
      ['a2', 'f2', 'pending'],
    ])
  })

  it('不在这一步里的未决定审批补在末尾，找不到工具帧时没有 frame', () => {
    const a1 = interaction('a1', 'pending')
    const orphan = interaction('ghost', 'pending')

    const batch = approvalBatch([turn(step('s1', [call('f1', 'a1')]))], known(a1, orphan), [
      a1,
      orphan,
    ])

    expect(batch.map((item) => [item.interactionId, item.frame?.frameId])).toEqual([
      ['a1', 'f1'],
      ['ghost', undefined],
    ])
  })

  it('提问类交互不进审批卡', () => {
    const question: TranscriptInteraction = {
      interactionId: 'q1',
      interactionKind: 'question',
      state: 'pending',
    }
    expect(approvalBatch([], known(question), [question])).toEqual([])
  })
})
