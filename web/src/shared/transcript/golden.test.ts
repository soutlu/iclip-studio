/** 后端场景测试存下的金样，用 vendored schema 逐帧解析并回放：两端形状对不上先在这里红。 */

import { describe, expect, it } from 'vitest'
import backgroundTurn from '../../../../contract/transcript/background-turn.json'
import delegateTurn from '../../../../contract/transcript/delegate-turn.json'
import toolTurn from '../../../../contract/transcript/tool-turn.json'
import {
  AgentTranscript,
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  transcriptResponseSchema,
} from './vendor'
import type { TranscriptOpsEvent } from './vendor'

interface Golden {
  ws?: Array<{ type: string; stream_epoch?: unknown; payload: { type?: unknown } }>
  rest: unknown
  child_rest?: unknown
}

const SAMPLES: Record<string, Golden> = {
  'tool-turn': toolTurn,
  'delegate-turn': delegateTurn,
  'background-turn': backgroundTurn,
}

describe.each(Object.keys(SAMPLES))('金样 %s', (name) => {
  const sample = SAMPLES[name] as Golden

  it('实时流 epoch 在页的信封与每帧信封上都有（客户端续订要带它）', () => {
    // vendored schema 不认这个信封字段，这里直接看原始金样，免得被 schema 剥掉后测不出缺失。
    expect((sample.rest as { stream_epoch?: unknown }).stream_epoch).toEqual(expect.any(String))
    for (const frame of sample.ws ?? []) expect(frame.stream_epoch).toEqual(expect.any(String))
  })

  it('每帧载荷自己带 type，与外层相同（客户端直接把载荷交给事件 schema）', () => {
    for (const frame of sample.ws ?? []) expect(frame.payload.type).toBe(frame.type)
  })

  it('REST 一页过 transcript schema', () => {
    const page = transcriptResponseSchema.parse(sample.rest)
    expect(page.agent_id).toBe('main')
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.agents.map((agent) => agent.type)).toContain('main')
    // zod 默认剥掉未声明字段：schema 漏了 triggerPromptId 这里会红，而不是悄悄丢。
    for (const item of page.items) {
      if (item.kind === 'turn') expect(item.triggerPromptId).toBeDefined()
    }
  })

  it.skipIf(sample.child_rest === undefined)('子代理那一页过同一个 schema', () => {
    const page = transcriptResponseSchema.parse(sample.child_rest)
    expect(page.agent_id).not.toBe('main')
    expect(page.items.filter((item) => item.kind === 'turn')).toHaveLength(1)
    expect(page.agents.map((agent) => agent.agentId)).toContain(page.agent_id)
  })

  it.skipIf(sample.ws === undefined)('WS 帧序列逐帧过 schema，回放不缺批、轮数与 REST 一致', () => {
    const frames = sample.ws ?? []
    expect(frames[0]?.type).toBe('transcript.reset')
    // 与 connection.ts 同一种喂法：载荷原样交给事件 schema。
    const reset = transcriptResetEventSchema.parse(frames[0]?.payload)
    expect(reset.agent_id).toBe('main')

    const transcript = new AgentTranscript('main')
    for (const frame of frames.slice(1)) {
      expect(frame.type).toBe('transcript.ops')
      // schema 推出的类型带 `?: T | undefined`，与 exactOptionalPropertyTypes 下的接口不等价，按 vendored 接口收窄。
      const batch = transcriptOpsEventSchema.parse(frame.payload) as TranscriptOpsEvent
      const applied = transcript.apply(batch.ops)
      expect(applied.gap).toBeUndefined()
    }
    const page = transcriptResponseSchema.parse(sample.rest)
    expect(transcript.getItems().filter((item) => item.kind === 'turn')).toHaveLength(
      page.items.filter((item) => item.kind === 'turn').length,
    )
  })
})

describe('金样 background-turn 的后台工具字段', () => {
  // 已发布字段只增不改（contract/conventions.md「后台工具」）：经 schema 解析后两处都还在，没被剥掉。
  const page = transcriptResponseSchema.parse(backgroundTurn.rest)

  it('页里有带 taskId 的 user 正文块（完成通知）', () => {
    const frames = page.items.flatMap((item) =>
      item.kind === 'turn' ? item.steps.flatMap((step) => step.frames) : [],
    )
    expect(
      frames.some(
        (frame) => frame.kind === 'text' && frame.role === 'user' && frame.taskId !== undefined,
      ),
    ).toBe(true)
  })

  it('tasks 里有 kind 为 tool 的任务', () => {
    expect(page.tasks.some((task) => task.kind === 'tool')).toBe(true)
  })
})
