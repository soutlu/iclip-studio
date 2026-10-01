import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { mockTranscriptPage } from '@/testing/mocks/transcript'
import { FakeTranscriptServer, type SeedStream } from '@/testing/transcript-server'
import { TranscriptConnection } from './connection'
import { LocalPromptStore } from './local-prompts'
import { MainTranscriptPool } from './main-pool'
import type { TranscriptOperation } from './vendor'
import type { TranscriptView } from './view'

const TAIL_TEXT = '这是第 2 轮的回复。'
const TAIL_FRAME = { frameId: 't2.1.f3', stepId: 't2.1', turnId: 't2', type: 'frame' } as const

const append = (offset: number, text: string): TranscriptOperation[] => [
  { offset, op: 'append', target: TAIL_FRAME, text },
]

const HISTORY = mockTranscriptPage().items as unknown as SeedStream['items']

/** 一轮只有一句回复的历史；ordinal 从 1 起。 */
const turn = (ordinal: number) => ({
  content: [{ text: `第 ${ordinal} 问`, type: 'text' }],
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  state: 'completed',
  steps: [
    {
      frames: [
        { frameId: `t${ordinal}.1.f1`, kind: 'text', role: 'assistant', text: `回复 ${ordinal}` },
      ],
      kind: 'step',
      ordinal: 1,
      state: 'completed',
      stepId: `t${ordinal}.1`,
      turnId: `t${ordinal}`,
    },
  ],
  turnId: `t${ordinal}`,
})

const textOf = (view: TranscriptView): string =>
  view.items
    .flatMap((item) => (item.kind === 'turn' ? item.steps : []))
    .flatMap((step) => step.frames)
    .map((frame) => ('text' in frame ? frame.text : ''))
    .join('|')

const turnIds = (view: TranscriptView) =>
  view.items.flatMap((item) => (item.kind === 'turn' ? [item.turnId] : []))

let pools: MainTranscriptPool[] = []

const setup = ({
  conversations = ['c1'],
  items = HISTORY,
  maxResident,
}: { conversations?: string[]; items?: SeedStream['items']; maxResident?: number } = {}) => {
  const fake = new FakeTranscriptServer()
  for (const id of conversations) fake.seed(id, 'main', { items, title: '夜景' })
  server.use(...fake.handlers())
  const connection = new TranscriptConnection({
    createSocket: fake.createSocket,
    url: 'ws://test/api/ws',
  })
  connection.connect()
  const localPrompts = new LocalPromptStore()
  const pool = new MainTranscriptPool({
    connection,
    localPrompts,
    ...(maxResident === undefined ? {} : { maxResident }),
  })
  pools.push(pool)
  return { connection, fake, localPrompts, pool }
}

const ready = async (pool: MainTranscriptPool, id = 'c1') =>
  vi.waitFor(() => expect(pool.view(id).status).toBe('ready'))

/** 让排在宏任务里的帧与回调都跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

afterEach(() => {
  for (const pool of pools) pool.close()
  pools = []
})

describe('MainTranscriptPool', () => {
  it('打开对话：只读一次基线，再带水位与 epoch 订阅，服务端不回 reset', async () => {
    const { fake, pool } = setup()
    pool.activate('c1')
    await ready(pool)
    await settle()

    expect(fake.pageRequests).toHaveLength(1)
    const subscribes = fake.received('subscribe_v2')
    expect(subscribes).toHaveLength(1)
    expect(subscribes[0]?.payload).toMatchObject({
      transcript_epoch: { main: fake.stream('c1').epoch },
      transcript_since: { main: 0 },
    })
    expect(pool.view('c1').title).toBe('夜景')

    fake.push('c1', 'main', append(TAIL_TEXT.length, '甲'))
    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toContain(`${TAIL_TEXT}甲`))
    expect(fake.pageRequests).toHaveLength(1)
  })

  it('主会话首屏读 10 轮，向上翻按 before_turn 取更早一页，旧页合并到前面', async () => {
    const items = Array.from({ length: 14 }, (_, index) => turn(index + 1))
    const { fake, pool } = setup({ items: items as unknown as SeedStream['items'] })
    pool.activate('c1')
    await ready(pool)

    expect(turnIds(pool.view('c1'))).toEqual(items.slice(4).map((item) => item.turnId))
    expect(pool.view('c1').hasMoreOlder).toBe(true)

    await pool.loadOlder('c1')
    await vi.waitFor(() => expect(turnIds(pool.view('c1'))).toHaveLength(14))
    expect(fake.pageRequests.at(-1)).toMatchObject({ beforeTurn: 't5' })
    expect(pool.view('c1').hasMoreOlder).toBe(false)
  })

  it('翻旧页期间来的实时批次先攒着，读完回放一次，不丢也不重复', async () => {
    const items = Array.from({ length: 14 }, (_, index) => turn(index + 1))
    const { fake, pool } = setup({ items: items as unknown as SeedStream['items'] })
    pool.activate('c1')
    await ready(pool)

    const release = fake.holdPages()
    const older = pool.loadOlder('c1')
    await vi.waitFor(() => expect(pool.view('c1').loadingOlder).toBe(true))
    fake.push('c1', 'main', [
      {
        offset: '回复 14'.length,
        op: 'append',
        target: { frameId: 't14.1.f1', stepId: 't14.1', turnId: 't14', type: 'frame' },
        text: '续',
      },
    ])
    await settle()
    expect(textOf(pool.view('c1'))).not.toContain('回复 14续')
    release()
    await older

    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toContain('回复 14续'))
    expect(textOf(pool.view('c1'))).not.toContain('回复 14续续')
    expect(turnIds(pool.view('c1'))).toHaveLength(14)
  })

  it('窗口内断线重连：带着水位重订，只补缺的那几批，不重读基线', async () => {
    const { connection, fake, pool } = setup()
    pool.activate('c1')
    await ready(pool)

    fake.dropConnections()
    fake.push('c1', 'main', append(TAIL_TEXT.length, '甲'))
    fake.push('c1', 'main', append(TAIL_TEXT.length + 1, '乙'))
    connection.reconnect()

    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toContain(`${TAIL_TEXT}甲乙`))
    expect(fake.pageRequests).toHaveLength(1)
    expect(fake.received('subscribe_v2').at(-1)?.payload).toMatchObject({
      transcript_since: { main: 0 },
    })
  })

  it('服务重启（epoch 变了）：收到 reset 后重读基线，新流里号更小的批次照常接上', async () => {
    const { connection, fake, pool } = setup()
    pool.activate('c1')
    await ready(pool)
    fake.push('c1', 'main', append(TAIL_TEXT.length, '甲'))
    fake.push('c1', 'main', append(TAIL_TEXT.length + 1, '乙'))
    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toContain(`${TAIL_TEXT}甲乙`))
    expect(connection.watermarkOf('c1', 'main')?.seq).toBe(2)

    fake.restart()
    const restarted = fake.stream('c1').epoch
    connection.reconnect()
    // 新流的第 1 批：号比旧水位小，epoch 不同，不能当重复批次吞掉。
    await vi.waitFor(() => expect(connection.watermarkOf('c1', 'main')?.epoch).toBe(restarted))
    fake.push('c1', 'main', append(TAIL_TEXT.length + 2, '丙'))

    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toContain(`${TAIL_TEXT}甲乙丙`))
    await vi.waitFor(() =>
      expect(connection.watermarkOf('c1', 'main')).toEqual({ epoch: restarted, seq: 1 }),
    )
    expect(fake.pageRequests.length).toBeGreaterThanOrEqual(2)
  })

  it('批次号断档：重读基线再带新水位重订', async () => {
    const { fake, pool } = setup()
    pool.activate('c1')
    await ready(pool)

    fake.push('c1', 'main', append(TAIL_TEXT.length, '甲'), { deliver: false })
    fake.push('c1', 'main', append(TAIL_TEXT.length + 1, '乙'))

    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toContain(`${TAIL_TEXT}甲乙`))
    expect(fake.pageRequests).toHaveLength(2)
    expect(fake.received('subscribe_v2').at(-1)?.payload).toMatchObject({
      transcript_since: { main: 2 },
    })
  })

  it('append 位置接不上：同样重读基线纠正', async () => {
    const { fake, pool } = setup()
    pool.activate('c1')
    await ready(pool)

    const stream = fake.stream('c1')
    fake.broadcast({
      payload: { agent_id: 'main', ops: append(999, '错位'), seq: stream.seq + 1 },
      seq: 0,
      session_id: 'c1',
      stream_epoch: stream.epoch,
      type: 'transcript.ops',
    })

    await vi.waitFor(() => expect(fake.pageRequests).toHaveLength(2))
    await ready(pool)
    expect(textOf(pool.view('c1'))).toContain(TAIL_TEXT)
    expect(textOf(pool.view('c1'))).not.toContain('错位')
  })

  it('重读在途时到的带内容的 reset：读完再落地，随后回放它之后的批次', async () => {
    const { fake, pool } = setup()
    pool.activate('c1')
    await ready(pool)
    const stream = fake.stream('c1')

    const release = fake.holdPages()
    pool.refresh('c1')
    await vi.waitFor(() => expect(fake.pageRequests).toHaveLength(2))
    const resetItem = turn(9)
    fake.broadcast({
      payload: {
        agent_id: 'main',
        has_more_older: false,
        seq: 40,
        snapshot: {
          interactions: [],
          items: [resetItem],
          meta: {},
          prompts: [],
          tasks: [],
          todos: [],
        },
      },
      seq: 0,
      session_id: 'c1',
      stream_epoch: stream.epoch,
      type: 'transcript.reset',
    })
    fake.broadcast({
      payload: {
        agent_id: 'main',
        ops: [
          {
            offset: '回复 9'.length,
            op: 'append',
            target: { frameId: 't9.1.f1', stepId: 't9.1', turnId: 't9', type: 'frame' },
            text: '后续',
          },
        ],
        seq: 41,
      },
      seq: 0,
      session_id: 'c1',
      stream_epoch: stream.epoch,
      type: 'transcript.ops',
    })
    await settle()
    release()

    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toBe('回复 9后续'))
  })

  it('翻旧页在途时到的带内容的 reset：等旧页读完再落地，随后回放它之后的批次', async () => {
    const items = Array.from({ length: 14 }, (_, index) => turn(index + 1))
    const { fake, pool } = setup({ items: items as unknown as SeedStream['items'] })
    pool.activate('c1')
    await ready(pool)
    const stream = fake.stream('c1')

    const release = fake.holdPages()
    const older = pool.loadOlder('c1')
    await vi.waitFor(() => expect(pool.view('c1').loadingOlder).toBe(true))
    fake.broadcast({
      payload: {
        agent_id: 'main',
        has_more_older: false,
        seq: 40,
        snapshot: {
          interactions: [],
          items: [turn(9)],
          meta: {},
          prompts: [],
          tasks: [],
          todos: [],
        },
      },
      seq: 0,
      session_id: 'c1',
      stream_epoch: stream.epoch,
      type: 'transcript.reset',
    })
    fake.broadcast({
      payload: {
        agent_id: 'main',
        ops: [
          {
            offset: '回复 9'.length,
            op: 'append',
            target: { frameId: 't9.1.f1', stepId: 't9.1', turnId: 't9', type: 'frame' },
            text: '后续',
          },
        ],
        seq: 41,
      },
      seq: 0,
      session_id: 'c1',
      stream_epoch: stream.epoch,
      type: 'transcript.ops',
    })
    await settle()
    release()
    await older

    await vi.waitFor(() => expect(textOf(pool.view('c1'))).toBe('回复 9后续'))
  })

  it('读基线途中就没人用了、又被更近用过的挤到后面：不淘汰在途的这一份，读完常驻，再用不重读', async () => {
    const { fake, pool } = setup({ conversations: ['c1', 'c2', 'c3'], maxResident: 1 })
    for (const id of ['c2', 'c3']) {
      const release = pool.activate(id)
      await ready(pool, id)
      release()
    }
    const release = fake.holdPages()
    pool.activate('c1')()
    await vi.waitFor(() => expect(fake.pageRequests.at(-1)?.conversationId).toBe('c1'))
    // c3 还常驻，再用它不读基线，但会把 c1 挤成最久没碰的那个。
    pool.activate('c3')()
    release()
    await settle()
    const asked = fake.pageRequests.length

    pool.activate('c1')
    await settle()
    expect(pool.view('c1').status).toBe('ready')
    expect(fake.pageRequests).toHaveLength(asked)
  })

  it('重读在途时到的空 reset 不替换内容，读完之后按退避再读一次', async () => {
    const { fake, pool } = setup()
    pool.activate('c1')
    await ready(pool)
    const stream = fake.stream('c1')

    const release = fake.holdPages()
    pool.refresh('c1')
    await vi.waitFor(() => expect(fake.pageRequests).toHaveLength(2))
    fake.broadcast({
      payload: {
        agent_id: 'main',
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
    release()
    await settle()

    expect(textOf(pool.view('c1'))).toContain(TAIL_TEXT)
    await vi.waitFor(() => expect(fake.pageRequests).toHaveLength(3), { timeout: 5_000 })
    expect(textOf(pool.view('c1'))).toContain(TAIL_TEXT)
  })

  it('重读期间本地又发了一条：读完再读一次，免得旧基线盖住刚发的那轮', async () => {
    const { fake, localPrompts, pool } = setup()
    const release = fake.holdPages()
    pool.activate('c1')
    await vi.waitFor(() => expect(fake.pageRequests).toHaveLength(1))

    localPrompts.begin(
      'c1',
      { content: [{ text: '再来一条', type: 'text' }], promptId: 'p-local' },
      { prompts: [], turnActive: false, turns: [] },
    )
    release()

    await ready(pool)
    await settle()
    expect(fake.pageRequests).toHaveLength(2)
  })

  it('超出常驻数时淘汰最久没用的；本地还有没被接替的发送的不淘汰', async () => {
    const { fake, localPrompts, pool } = setup({
      conversations: ['c1', 'c2', 'c3'],
      maxResident: 1,
    })
    for (const id of ['c1', 'c2', 'c3']) {
      const release = pool.activate(id)
      await ready(pool, id)
      if (id === 'c1') {
        localPrompts.begin(
          'c1',
          { content: [{ text: '还没回执', type: 'text' }], promptId: 'p-c1' },
          { prompts: [], turnActive: false, turns: [] },
        )
      }
      release()
    }
    await settle()

    const unsubscribed = fake.received('unsubscribe_v2').map((frame) => frame.payload?.session_id)
    expect(unsubscribed).toEqual(['c2'])

    // c1 还常驻：再用它不重读基线。
    const before = fake.pageRequests.length
    pool.activate('c1')
    await settle()
    expect(fake.pageRequests).toHaveLength(before)
    expect(pool.view('c1').status).toBe('ready')
  })

  it('有人在用的对话不淘汰，切回来不重读基线', async () => {
    const { fake, pool } = setup({ conversations: ['c1', 'c2'], maxResident: 1 })
    pool.activate('c1')
    await ready(pool, 'c1')
    const releaseC2 = pool.activate('c2')
    await ready(pool, 'c2')
    releaseC2()
    await settle()

    expect(fake.received('unsubscribe_v2')).toHaveLength(0)
    const before = fake.pageRequests.length
    pool.activate('c2')
    await settle()
    expect(fake.pageRequests).toHaveLength(before)
  })

  it('对话不存在：停在错误态，不重试', async () => {
    const { fake, pool } = setup({ conversations: [] })
    pool.activate('missing')

    await vi.waitFor(() => expect(pool.view('missing').status).toBe('error'))
    expect(pool.view('missing').error).toBe('这段对话不存在，或者不是你的')
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(fake.pageRequests).toHaveLength(1)
  })
})
