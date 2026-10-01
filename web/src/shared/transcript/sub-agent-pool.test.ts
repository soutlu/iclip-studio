import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { mockChildPage } from '@/testing/mocks/transcript'
import { FakeTranscriptServer, type SeedStream } from '@/testing/transcript-server'
import { TranscriptConnection } from './connection'
import { SubAgentTranscriptPool } from './sub-agent-pool'
import type { TranscriptView } from './view'

const CHILD = 'run-child'
const OTHER = 'run-other'
const CHILD_ITEMS = mockChildPage('c1', 't2-child').items as unknown as SeedStream['items']

const textOf = (view: TranscriptView): string =>
  view.items
    .flatMap((item) => (item.kind === 'turn' ? item.steps : []))
    .flatMap((step) => step.frames)
    .map((frame) => ('text' in frame ? frame.text : ''))
    .join('|')

let pools: SubAgentTranscriptPool[] = []

const setup = () => {
  const fake = new FakeTranscriptServer()
  fake.seed('c1', 'main', { items: [] })
  fake.seed('c1', CHILD, { items: CHILD_ITEMS })
  fake.seed('c1', OTHER, { items: CHILD_ITEMS })
  server.use(...fake.handlers())
  const connection = new TranscriptConnection({
    createSocket: fake.createSocket,
    url: 'ws://test/api/ws',
  })
  connection.connect()
  const pool = new SubAgentTranscriptPool(connection)
  pools.push(pool)
  return { connection, fake, pool }
}

const ready = (pool: SubAgentTranscriptPool, agentId = CHILD) =>
  vi.waitFor(() => expect(pool.view('c1', agentId).status).toBe('ready'))

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

afterEach(() => {
  for (const pool of pools) pool.close()
  pools = []
})

describe('SubAgentTranscriptPool', () => {
  it('先读子代理那一页，再带水位订它那条流', async () => {
    const { fake, pool } = setup()
    pool.activate('c1', CHILD)
    await ready(pool)
    await settle()

    expect(fake.pageRequests).toEqual([{ agentId: CHILD, beforeTurn: null, conversationId: 'c1' }])
    expect(fake.received('subscribe_v2').at(-1)?.payload).toMatchObject({
      transcript: { [CHILD]: 'delta' },
      transcript_epoch: { [CHILD]: fake.stream('c1', CHILD).epoch },
      transcript_since: { [CHILD]: 0 },
    })
    expect(textOf(pool.view('c1', CHILD))).toContain('S3-1 特写')
  })

  it('空 reset 不清空已显示的过程，按退避重读那一页', async () => {
    const { fake, pool } = setup()
    pool.activate('c1', CHILD)
    await ready(pool)
    const stream = fake.stream('c1', CHILD)

    fake.broadcast({
      payload: {
        agent_id: CHILD,
        has_more_older: true,
        seq: stream.seq,
        snapshot: { interactions: [], items: [], meta: {}, prompts: [], tasks: [], todos: [] },
      },
      seq: 0,
      session_id: 'c1',
      stream_epoch: stream.epoch,
      type: 'transcript.reset',
    })
    await settle()

    expect(textOf(pool.view('c1', CHILD))).toContain('S3-1 特写')
    await vi.waitFor(() => expect(fake.pageRequests).toHaveLength(2), { timeout: 5_000 })
    expect(textOf(pool.view('c1', CHILD))).toContain('S3-1 特写')
  })

  it('同一段对话换看另一个子代理：退掉上一个，只订当前这个', async () => {
    const { fake, pool } = setup()
    pool.activate('c1', CHILD)
    await ready(pool)
    pool.activate('c1', OTHER)
    await ready(pool, OTHER)

    // 这段对话只订着子代理，退掉它就是整段退订；随后的订阅表里只剩当前这个。
    expect(fake.received('unsubscribe_v2')).toHaveLength(1)
    expect(fake.received('subscribe_v2').at(-1)?.payload?.transcript).toEqual({ [OTHER]: 'delta' })
  })

  it('断档时重读那一页再重订', async () => {
    const { fake, pool } = setup()
    pool.activate('c1', CHILD)
    await ready(pool)

    const frame = { frameId: 't1.1.f2', stepId: 't1.1', turnId: 't1', type: 'frame' } as const
    const head = textOf(pool.view('c1', CHILD)).split('|').at(-1) ?? ''
    fake.push('c1', CHILD, [{ offset: head.length, op: 'append', target: frame, text: '甲' }], {
      deliver: false,
    })
    fake.push('c1', CHILD, [{ offset: head.length + 1, op: 'append', target: frame, text: '乙' }])

    await vi.waitFor(() => expect(textOf(pool.view('c1', CHILD))).toContain(`${head}甲乙`))
    expect(fake.pageRequests).toHaveLength(2)
  })
})
