import { describe, expect, it } from 'vitest'
import type {
  TranscriptInteraction,
  TranscriptStep,
  TranscriptTurn,
} from '@/shared/transcript/vendor'
import { durationLabel, runTurns } from './run-steps'

const tool = (id: string, summary: string, fields: Record<string, unknown> = {}) => ({
  display: { kind: 'generic', summary },
  frameId: `f-${id}`,
  kind: 'tool' as const,
  name: `raw_${id}`,
  state: 'done' as const,
  toolCallId: id,
  ...fields,
})

const step = (
  ordinal: number,
  frames: TranscriptStep['frames'],
  timing: { startedAt?: string; endedAt?: string } = {},
  state: TranscriptStep['state'] = 'completed',
): TranscriptStep => ({
  frames,
  kind: 'step',
  ordinal,
  state,
  stepId: `t1.${ordinal}`,
  turnId: 't1',
  ...timing,
})

const turn = (steps: TranscriptStep[]): TranscriptTurn => ({
  content: [{ text: '试一条', type: 'text' }],
  kind: 'turn',
  ordinal: 1,
  origin: { kind: 'user' },
  state: 'completed',
  steps,
  turnId: 't1',
})

const noInteractions = new Map<string, TranscriptInteraction>()

describe('runTurns', () => {
  it('一步一行：几个工具写第一个加总数，只回复写回复，只思考写思考，什么都没有的步骤不列', () => {
    const [run] = runTurns(
      [
        turn([
          step(1, [tool('a', '读取参考素材'), tool('b', '理解视频')]),
          step(2, [{ frameId: 'th', kind: 'thinking', text: '先看节奏' }]),
          step(3, [{ frameId: 'tx', kind: 'text', role: 'assistant', text: '好的' }]),
          step(4, [{ frameId: 'blank', kind: 'text', role: 'assistant', text: '  ' }]),
        ]),
      ],
      noInteractions,
    )
    expect(run?.steps.map((item) => [item.icon, item.label])).toEqual([
      ['task', '读取参考素材 等 2 项'],
      ['thinking', '思考'],
      ['message', '回复'],
    ])
    expect(run?.steps[0]?.calls.map((call) => call.label)).toEqual(['读取参考素材', '理解视频'])
  })

  it('耗时取步骤与轮的起止时刻，缺一个就不给', () => {
    const [run] = runTurns(
      [
        {
          ...turn([
            step(1, [tool('a', '读取参考素材')], {
              endedAt: '2026-11-01T08:00:01.250Z',
              startedAt: '2026-11-01T08:00:00.000Z',
            }),
            step(2, [tool('b', '理解视频')], { startedAt: '2026-11-01T08:00:01.250Z' }, 'running'),
          ]),
          endedAt: '2026-11-01T08:01:05.000Z',
          startedAt: '2026-11-01T08:00:00.000Z',
        },
      ],
      noInteractions,
    )
    expect(run?.steps.map((item) => item.durationMs)).toEqual([1250, undefined])
    expect(run?.durationMs).toBe(65_000)
  })

  it('被拒绝的调用记为已拒绝，失败的记为失败；工具名不出现', () => {
    const interactions = new Map<string, TranscriptInteraction>([
      [
        'appr',
        {
          interactionId: 'appr',
          interactionKind: 'approval',
          state: 'rejected',
        },
      ],
    ])
    const [run] = runTurns(
      [
        turn([
          step(1, [
            tool('a', '写入文件', { approvalId: 'appr', state: 'error' }),
            tool('b', '理解视频', { state: 'error' }),
          ]),
        ]),
      ],
      interactions,
    )
    expect(run?.steps[0]?.calls.map((call) => call.outcome)).toEqual(['denied', 'error'])
    expect(JSON.stringify(run)).not.toContain('raw_')
  })
})

describe('durationLabel', () => {
  it.each([
    [1200, '1.2 s'],
    [59_940, '59.9 s'],
    [65_000, '1 分 05 秒'],
    [600_000, '10 分 00 秒'],
  ])('%i 毫秒写成 %s', (ms, label) => {
    expect(durationLabel(ms)).toBe(label)
  })
})
