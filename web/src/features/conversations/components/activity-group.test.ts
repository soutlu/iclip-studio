import { describe, expect, it } from 'vitest'
import type {
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptStep,
} from '@/shared/transcript/vendor'
import {
  failedTools,
  formatActivityDuration,
  groupActivityCards,
  groupTurnEntries,
  runHistoryMs,
  summarizeDone,
  summarizeRunning,
  type TurnEntry,
} from './activity-group'

const step: TranscriptStep = {
  endedAt: '2026-08-31T01:00:20Z',
  frames: [],
  kind: 'step',
  ordinal: 1,
  startedAt: '2026-08-31T01:00:00Z',
  state: 'completed',
  stepId: 't1.1',
  turnId: 't1',
}

const entry = (frame: TranscriptFrame): TurnEntry => ({ frame, step })

const timelessStep: TranscriptStep = (() => {
  const bare = { ...step }
  delete bare.startedAt
  delete bare.endedAt
  return bare
})()

const thinking = (id: string): TranscriptFrame => ({
  frameId: id,
  kind: 'thinking',
  text: '想',
})

const NO_INTERACTIONS: ReadonlyMap<string, TranscriptInteraction> = new Map()

const tool = (
  id: string,
  operation: 'read' | 'write' | 'edit' | 'glob' | 'grep' | undefined,
  state: 'running' | 'done' | 'error' = 'done',
  approvalId?: string,
): TranscriptFrame => ({
  ...(approvalId === undefined ? {} : { approvalId }),
  display:
    operation === undefined
      ? { kind: 'generic', summary: '出镜头帧' }
      : { kind: 'file_io', operation, path: 'shots/storyboard.md' },
  frameId: id,
  kind: 'tool',
  name: 'x',
  state,
  toolCallId: id,
})

const text = (id: string, role: 'assistant' | 'user' = 'assistant'): TranscriptFrame =>
  role === 'user'
    ? { content: [{ text: '字', type: 'text' }], frameId: id, kind: 'text', role, text: '字' }
    : { frameId: id, kind: 'text', role, text: '字' }

describe('groupTurnEntries', () => {
  it('连续的思考与工具折成一叠；正文打断一叠', () => {
    const nodes = groupTurnEntries([
      entry(text('u1', 'user')),
      entry(thinking('f1')),
      entry(tool('f2', 'grep')),
      entry(tool('f3', 'write')),
      entry(text('a1')),
      entry(tool('f4', 'read')),
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['entry', 'run', 'entry', 'entry'])
    const run = nodes[1]
    if (run?.kind !== 'run') throw new Error('应折成一叠')
    expect(run.items.map((item) => item.frame.frameId)).toEqual(['f1', 'f2', 'f3'])
  })

  it('派出了子代理的卡不进活动组，「查看」入口不能被折叠藏住', () => {
    const delegated: TranscriptFrame = {
      agentRefs: [{ agentId: 'run-child', role: 'child' }],
      display: { agent_name: 'shot-writer', kind: 'agent_call', prompt: '写三个镜头' },
      frameId: 'f2',
      kind: 'tool',
      name: 'delegate_task',
      state: 'done',
      toolCallId: 'f2',
    }

    const nodes = groupTurnEntries([
      entry(thinking('f1')),
      entry(delegated),
      entry(tool('f3', 'read')),
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['entry', 'entry', 'entry'])
  })

  it('单个工具不折；没有工具的纯思考连续块也不折', () => {
    expect(groupTurnEntries([entry(tool('f1', 'read'))])[0]?.kind).toBe('entry')
    expect(
      groupTurnEntries([entry(thinking('f1')), entry(thinking('f2'))]).map((node) => node.kind),
    ).toEqual(['entry', 'entry'])
  })
})

describe('groupActivityCards', () => {
  const delegated = (id: string): TranscriptFrame => ({
    agentRefs: [{ agentId: 'run-child', role: 'child' }],
    display: { agent_name: 'shot-writer', kind: 'agent_call', prompt: '写三个镜头' },
    frameId: id,
    kind: 'tool',
    name: 'delegate_task',
    state: 'done',
    toolCallId: id,
  })

  it('活动组与紧挨着的单独工具收进同一张卡，派活那一行仍不在活动组里', () => {
    const blocks = groupActivityCards(
      groupTurnEntries([
        entry(tool('f1', 'grep')),
        entry(tool('f2', 'write')),
        entry(delegated('f3')),
      ]),
    )

    expect(blocks).toHaveLength(1)
    const card = blocks[0]
    if (card?.kind !== 'card') throw new Error('应收进一张卡')
    expect(card.nodes.map((node) => node.kind)).toEqual(['run', 'entry'])
  })

  it('正文与单独的思考把卡隔开，各自成块', () => {
    const blocks = groupActivityCards(
      groupTurnEntries([
        entry(text('u1', 'user')),
        entry(tool('f1', 'read')),
        entry(text('a1')),
        entry(thinking('f2')),
        entry(delegated('f3')),
      ]),
    )

    expect(blocks.map((block) => block.kind)).toEqual(['entry', 'card', 'entry', 'entry', 'card'])
    expect(new Set(blocks.flatMap((b) => (b.kind === 'card' ? [b.cardId] : []))).size).toBe(2)
  })
})

describe('summarizeDone', () => {
  it('按类别聚合计数、保持出现顺序，失败缀危险子句，尾巴挂时长', () => {
    const clauses = summarizeDone(
      [
        entry(thinking('f1')),
        entry(tool('f2', 'grep')),
        entry(tool('f3', 'grep')),
        entry(tool('f4', 'write')),
        entry(tool('f5', undefined, 'error')),
        entry(tool('f6', undefined)),
      ],
      191_000,
      NO_INTERACTIONS,
    )

    expect(clauses.map((clause) => clause.text)).toEqual([
      '搜索了 2 次',
      '写入了 1 个文件',
      '出镜头帧 ×2',
      '（1 失败）',
      '3m11s',
    ])
    expect(clauses[3]?.tone).toBe('danger')
    expect(clauses[4]?.tone).toBe('faint')
  })
})

describe('被拒绝不算失败', () => {
  const rejected: ReadonlyMap<string, TranscriptInteraction> = new Map([
    [
      'appr_1',
      { interactionId: 'appr_1', interactionKind: 'approval', state: 'rejected', toolCallId: 'f2' },
    ],
  ])
  const items = [
    entry(tool('f1', 'read')),
    entry(tool('f2', 'edit', 'error', 'appr_1')),
    entry(tool('f3', 'edit', 'error')),
  ]

  it('摘要的失败数只数真正失败的调用，被拒绝的另记一句弱化的「已拒绝」', () => {
    const clauses = summarizeDone(items, undefined, rejected)
    expect(clauses.map((clause) => clause.text)).toEqual([
      '读取了 1 个文件',
      '编辑了 2 处',
      '（1 失败）',
      '（1 已拒绝）',
    ])
    expect(clauses[3]?.tone).toBe('faint')
  })

  it('收起时露出的失败行按各自状态挑，被拒绝的不在里面', () => {
    expect(failedTools(items, rejected).map((item) => item.frame.frameId)).toEqual(['f3'])
  })
})

describe('summarizeRunning', () => {
  it('当前子句当头，已完成的类别弱化带「已」，尾巴挂实时时长', () => {
    const clauses = summarizeRunning(
      [entry(thinking('f1')), entry(tool('f2', 'grep')), entry(tool('f3', 'read', 'running'))],
      'f3',
      20_000,
      NO_INTERACTIONS,
    )

    expect(clauses.map((clause) => clause.text)).toEqual([
      '正在读取 storyboard.md',
      '已搜索了 1 次',
      '20s',
    ])
  })

  it('直播块是思考时当前子句是「思考中…」', () => {
    const clauses = summarizeRunning(
      [entry(thinking('f1')), entry(tool('f2', 'grep'))],
      'f1',
      0,
      NO_INTERACTIONS,
    )
    expect(clauses[0]?.text).toBe('思考中…')
  })
})

describe('formatActivityDuration / runHistoryMs', () => {
  it('时长格式：20s、3m11s、1h2m、0 不出字', () => {
    expect(formatActivityDuration(0)).toBe('')
    expect(formatActivityDuration(400)).toBe('')
    expect(formatActivityDuration(20_000)).toBe('20s')
    expect(formatActivityDuration(191_000)).toBe('3m11s')
    expect(formatActivityDuration(3_600_000)).toBe('1h')
    expect(formatActivityDuration(3_720_000)).toBe('1h2m')
  })

  it('历史一叠的时长取成员步骤的最早开始与最晚结束', () => {
    expect(runHistoryMs([entry(thinking('f1')), entry(tool('f2', 'grep'))])).toBe(20_000)
    expect(runHistoryMs([{ frame: thinking('f3'), step: timelessStep }])).toBeUndefined()
  })
})
