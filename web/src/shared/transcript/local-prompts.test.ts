import { describe, expect, it, vi } from 'vitest'
import { LocalPromptStore, type LocalTimeline } from './local-prompts'
import type { TranscriptPrompt, TranscriptTurn } from './vendor'

const text = (value: string) => [{ text: value, type: 'text' as const }]

const item = (promptId: string, value = promptId) => ({ content: text(value), promptId })

const turn = (turnId: string, triggerPromptId: string): TranscriptTurn => ({
  content: text('不相干'),
  kind: 'turn',
  ordinal: Number(turnId.slice(1)),
  origin: { kind: 'user' },
  state: 'running',
  steps: [],
  triggerPromptId,
  turnId,
})

const prompt = (promptId: string, status: TranscriptPrompt['status']): TranscriptPrompt => ({
  content: text(promptId),
  createdAt: '2026-10-01T00:00:00Z',
  promptId,
  status,
})

const idle: LocalTimeline = { prompts: [], turnActive: false, turns: [] }

describe('LocalPromptStore', () => {
  it('发出一条：挂上气泡、开起在途的一轮、记一个未回执请求，generation 加一', () => {
    const store = new LocalPromptStore()
    const startsFlight = store.begin('c1', item('p1'), idle)

    expect(startsFlight).toBe(true)
    expect(store.get('c1')).toMatchObject({ inFlightPromptId: 'p1', pending: [item('p1')] })
    expect(store.getLocalTurnState('c1')).toEqual({ generation: 1, pending: 1 })
    expect(store.hasPendingLocalWork('c1', idle)).toBe(true)
  })

  it('回执只减未回执数，气泡与在途那一轮留着等时间线接替', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    store.accepted('c1', 'p1')

    expect(store.getLocalTurnState('c1')).toEqual({ generation: 2, pending: 0 })
    expect(store.get('c1')).toMatchObject({ inFlightPromptId: 'p1', pending: [item('p1')] })
    // 时间线还没接替它，仍是本地未完成的工作。
    expect(store.hasPendingLocalWork('c1', idle)).toBe(true)
  })

  it('时间线接替气泡、那一轮收尾之后，就没有本地未完成的工作', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    store.accepted('c1', 'p1')

    const done: LocalTimeline = {
      prompts: [prompt('p1', 'completed')],
      turnActive: false,
      turns: [turn('t1', 'p1')],
    }
    expect(store.hasPendingLocalWork('c1', done)).toBe(false)
    // 认领由时间线推导，store 里的记录不动。
    expect(store.get('c1').pending).toEqual([item('p1')])
  })

  it('那一轮还在跑时算未完成，即使气泡已被接替', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    store.accepted('c1', 'p1')

    const running: LocalTimeline = {
      prompts: [prompt('p1', 'running')],
      turnActive: true,
      turns: [turn('t1', 'p1')],
    }
    expect(store.hasPendingLocalWork('c1', running)).toBe(true)
  })

  it('发送失败撤回气泡；它开起的那一轮一并撤销', () => {
    const store = new LocalPromptStore()
    const startsFlight = store.begin('c1', item('p1'), idle)
    store.rollback('c1', 'p1', startsFlight)

    expect(store.get('c1')).toMatchObject({ inFlightPromptId: null, pending: [] })
    expect(store.getLocalTurnState('c1')).toEqual({ generation: 2, pending: 0 })
    expect(store.hasPendingLocalWork('c1', idle)).toBe(false)
  })

  it('在途时再发一条不改在途那一轮；后一条失败不撤前一条开起的轮', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    const second = store.begin('c1', item('p2'), idle)

    expect(second).toBe(false)
    expect(store.get('c1').inFlightPromptId).toBe('p1')
    store.rollback('c1', 'p2', second)
    expect(store.get('c1')).toMatchObject({ inFlightPromptId: 'p1', pending: [item('p1')] })
  })

  it('上一轮已收尾但记录还没清时再发，由新的一条开起新一轮', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    store.accepted('c1', 'p1')

    const settled: LocalTimeline = {
      prompts: [prompt('p1', 'completed')],
      turnActive: false,
      turns: [turn('t1', 'p1')],
    }
    expect(store.begin('c1', item('p2'), settled)).toBe(true)
    // 已被接替的 p1 在这次发送时清掉。
    expect(store.get('c1')).toMatchObject({ inFlightPromptId: 'p2', pending: [item('p2')] })
  })

  it('排队中的算已接替但不清掉：开跑后还没有轮时气泡要重新出现', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    const queued: LocalTimeline = {
      prompts: [prompt('p1', 'queued')],
      turnActive: true,
      turns: [],
    }
    // 排队期间再发一条，p1 按「已接替」清掉；这是此前组件内的同一条规则。
    store.begin('c1', item('p2'), queued)
    expect(store.get('c1').pending).toEqual([item('p2')])
  })

  it('回执与失败只销自己那一条请求；未登记的失败不动别人的', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    store.begin('c1', item('p2'), idle)
    store.accepted('c1', 'p2')
    expect(store.get('c1').requests).toEqual(['p1'])

    store.rollback('c1', 'never-begun', false)
    expect(store.getLocalTurnState('c1').pending).toBe(1)
  })

  it('收尾只清当前这一轮', () => {
    const store = new LocalPromptStore()
    store.begin('c1', item('p1'), idle)
    store.settle('c1', 'other')
    expect(store.get('c1').inFlightPromptId).toBe('p1')

    store.settle('c1', 'p1')
    expect(store.get('c1').inFlightPromptId).toBeNull()
    expect(store.getLocalTurnState('c1').generation).toBe(2)
  })

  it('按对话隔离；没动过的对话返回同一个空快照', () => {
    const store = new LocalPromptStore()
    const empty = store.get('c2')
    store.begin('c1', item('p1'), idle)

    expect(store.get('c2')).toBe(empty)
    expect(store.getLocalTurnState('c2')).toEqual({ generation: 0, pending: 0 })
    expect(store.hasPendingLocalWork('c2', idle)).toBe(false)
  })

  it('两次变化之间快照引用不变，每次变化通知订阅者', () => {
    const store = new LocalPromptStore()
    const listener = vi.fn()
    const stop = store.subscribe(listener)

    store.begin('c1', item('p1'), idle)
    const snapshot = store.get('c1')
    expect(store.get('c1')).toBe(snapshot)
    expect(listener).toHaveBeenCalledTimes(1)

    stop()
    store.accepted('c1', 'p1')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get('c1')).not.toBe(snapshot)
  })
})
