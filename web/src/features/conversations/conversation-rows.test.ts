import { describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@/shared/transcript/connection'
import { ConversationRowStore } from './conversation-rows'

const ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001'

const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  activity: {
    busy: false,
    lastTurnReason: null,
    pendingInteraction: 'none',
    videoGeneration: 'none',
  },
  agentId: 'storyboard',
  collectionId: null,
  completedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  deletedAt: null,
  eventEpoch: 'e1',
  forkTurn: null,
  forkedFrom: null,
  id: ID,
  lastRunId: null,
  lastSeq: 0,
  ownerUserId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002',
  taskId: null,
  title: '原名',
  updatedAt: '2026-10-01T00:00:00Z',
  ...overrides,
})

const mark = (seq: number, epoch = 'e1') => ({ epoch, ownerUserId: 'u1', seq })
const busy = { busy: true, lastTurnReason: null, pendingInteraction: 'none' } as const
const idle = { busy: false, lastTurnReason: 'completed', pendingInteraction: 'none' } as const

describe('ConversationRowStore 合并规则（合同 §5 水位）', () => {
  it('帧序号大于行的 lastSeq 才算新：读库早于帧的行晚到，盖不掉帧上的活动', () => {
    const store = new ConversationRowStore()
    store.mergeRows([row({ lastSeq: 3 })])

    store.applyActivity(ID, busy, mark(5))
    expect(store.get(ID)?.activity.busy).toBe(true)

    // 这一行读库时这段对话只发到 4，不含第 5 帧。
    store.mergeRows([row({ lastSeq: 4, title: '读库时的名字' })])
    expect(store.get(ID)?.activity.busy).toBe(true)
    // 别的分组水位不高于 4，照收。
    expect(store.get(ID)?.title).toBe('读库时的名字')
  })

  it('行的 lastSeq 等于帧序号：读库晚于这一帧，行里已经有它，行说了算', () => {
    const store = new ConversationRowStore()
    store.mergeRows([row({ lastSeq: 3 })])
    store.applyActivity(ID, busy, mark(5))

    store.mergeRows([row({ activity: { ...row().activity, ...idle }, lastSeq: 5 })])

    expect(store.get(ID)?.activity).toMatchObject(idle)
  })

  it('写入前读库的行晚于 updated 帧到达：事实字段不回退', () => {
    const store = new ConversationRowStore()
    store.mergeRows([row({ lastSeq: 2 })])
    // 换合集：写入前水位 2，提交后为这一帧发号 3。
    store.applyRow(row({ collectionId: 'c-new', lastSeq: 2 }), mark(3))
    expect(store.get(ID)?.collectionId).toBe('c-new')

    store.mergeRows([row({ collectionId: null, lastSeq: 2 })])

    expect(store.get(ID)?.collectionId).toBe('c-new')
  })

  it('updated 帧里内嵌的活动比之前的 work_changed 旧：轮次活动不回退，事实字段照收', () => {
    const store = new ConversationRowStore()
    store.mergeRows([row({ lastSeq: 4 })])
    store.applyActivity(ID, busy, mark(6))

    // 行内 lastSeq 5 早于第 6 帧，内嵌活动还是闲着。
    store.applyRow(row({ completedAt: '2026-10-01T01:00:00Z', lastSeq: 5, title: '改名' }), mark(7))

    expect(store.get(ID)?.activity.busy).toBe(true)
    expect(store.get(ID)?.title).toBe('改名')
    expect(store.get(ID)?.completedAt).toBe('2026-10-01T01:00:00Z')
  })

  it('视频汇总没有帧来源，单独成组：轮次帧的水位挡不住行上的视频汇总', () => {
    const store = new ConversationRowStore()
    store.mergeRows([row({ lastSeq: 3 })])
    store.applyActivity(ID, busy, mark(6))

    store.mergeRows([
      row({ activity: { ...row().activity, videoGeneration: 'running' }, lastSeq: 4 }),
    ])

    expect(store.get(ID)?.activity).toMatchObject({ busy: true, videoGeneration: 'running' })
  })

  it('开跑帧把收尾标记记成空，水位同这一帧：开跑前读库的行带着旧标记晚到也不复原', () => {
    const store = new ConversationRowStore()
    store.mergeRows([row({ completedAt: '2026-10-01T01:00:00Z', lastSeq: 2 })])

    store.applyActivity(ID, busy, mark(4))
    store.mergeRows([row({ completedAt: '2026-10-01T01:00:00Z', lastSeq: 3 })])

    expect(store.get(ID)?.completedAt).toBeNull()
  })

  it('行还没到先来了帧：先记下，读库早于帧的行到了也保留帧值', () => {
    const store = new ConversationRowStore()
    store.applyTitle(ID, '帧上的名字', mark(2))
    expect(store.get(ID)).toBeUndefined()

    store.mergeRows([row({ lastSeq: 1 })])
    expect(store.get(ID)?.title).toBe('帧上的名字')

    store.mergeRows([row({ lastSeq: 2, title: '库里的名字' })])
    expect(store.get(ID)?.title).toBe('库里的名字')
  })

  it('删除记墓碑：活行不再收、视图里消失；带 deletedAt 的墓碑行（治理者复盘）照收', () => {
    const store = new ConversationRowStore()
    const live = row({ lastSeq: 1 })
    store.mergeRows([live])

    store.applyDeleted(ID)

    expect(store.mergeRows([row({ lastSeq: 1 })])).toEqual([])
    expect(store.resolve(live)).toBeNull()
    const tomb = row({ deletedAt: '2026-10-01T02:00:00Z', lastSeq: 3 })
    expect(store.mergeRows([tomb])).toHaveLength(1)
    expect(store.resolveAll([live], true)).toEqual([live])
  })

  describe('epoch 按本池第一次见到的先后排', () => {
    it('没见过的 epoch 视为更新：整行收下，水位从它重新算', () => {
      const store = new ConversationRowStore()
      store.mergeRows([row({ lastSeq: 2 })])
      store.applyActivity(ID, busy, mark(9))

      // 服务重启：新进程序号从头编，行上 lastSeq 只有 1，但它更新。
      store.mergeRows([
        row({ activity: { ...row().activity, ...idle }, eventEpoch: 'e2', lastSeq: 1 }),
      ])

      expect(store.get(ID)?.activity).toMatchObject(idle)
      store.applyActivity(ID, busy, mark(2, 'e2'))
      expect(store.get(ID)?.activity.busy).toBe(true)
    })

    it('比这一行当前 epoch 更早的来源一律丢弃，行与帧都是', () => {
      const store = new ConversationRowStore()
      store.mergeRows([row({ lastSeq: 1 })])
      store.mergeRows([row({ eventEpoch: 'e2', lastSeq: 1, title: '新进程' })])

      store.mergeRows([row({ lastSeq: 50, title: '旧进程晚到的行' })])
      store.applyTitle(ID, '旧进程晚到的帧', mark(60))

      expect(store.get(ID)?.title).toBe('新进程')
    })
  })

  it('没有变化不换引用，一批写入只通知一次', () => {
    const store = new ConversationRowStore()
    const [first] = store.mergeRows([row({ lastSeq: 1 })])
    const listener = vi.fn()
    store.subscribe(listener)

    const [again] = store.mergeRows([row({ lastSeq: 1 })])
    expect(again).toBe(first)
    expect(listener).not.toHaveBeenCalled()

    const input = [row({ lastSeq: 1 })]
    expect(store.resolveAll(input, false)).toBe(store.resolveAll(input, false))

    store.batch(() => {
      store.applyTitle(ID, '甲', mark(2))
      store.applyActivity(ID, busy, mark(3))
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('带额外字段的行（全部对话页的成片地址）解析后保留这些字段，池里只存对话行本身', () => {
    const store = new ConversationRowStore()
    const audit = { ...row({ lastSeq: 1 }), latestMasterUrl: 'https://cdn.example/a.mp4' }

    const [merged] = store.mergeRows([audit])
    store.applyTitle(ID, '改名', mark(2))

    expect(merged?.latestMasterUrl).toBe('https://cdn.example/a.mp4')
    expect(store.get(ID)).not.toHaveProperty('latestMasterUrl')
    expect(store.resolve(audit)).toMatchObject({
      latestMasterUrl: 'https://cdn.example/a.mp4',
      title: '改名',
    })
  })
})
