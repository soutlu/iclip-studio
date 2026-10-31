import { describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@/shared/transcript/connection'
import { ConversationRowStore } from './conversation-rows'

const ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001'

const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  activity: { busy: false, lastTurnReason: null, pendingInteraction: 'none' },
  agentId: 'storyboard',
  collectionId: null,
  completedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  deletedAt: null,
  forkTurn: null,
  forkedFrom: null,
  id: ID,
  lastRunId: null,
  ownerUserId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002',
  taskId: null,
  title: '原名',
  updatedAt: '2026-10-01T00:00:00Z',
  ...overrides,
})

const busy = { busy: true, lastTurnReason: null, pendingInteraction: 'none' } as const
const idle = { busy: false, lastTurnReason: 'completed', pendingInteraction: 'none' } as const

/** 一次已经读完的 HTTP 请求：开本、合并、关本。 */
const read = <T extends SessionRow>(store: ConversationRowStore, rows: T[]): T[] => {
  const book = store.open()
  const merged = store.mergeRows(rows, book)
  book.close()
  return merged
}

/** 一次在途的请求：本子已开，`settle` 交回结果。 */
const inFlight = (store: ConversationRowStore) => {
  const book = store.open()
  return {
    settle: (rows: SessionRow[]) => {
      const merged = store.mergeRows(rows, book)
      book.close()
      return merged
    },
  }
}

describe('ConversationRowStore 记录本', () => {
  it('拉列表期间到达的帧：结果晚回来、行里还是旧值，也盖不掉它', () => {
    const store = new ConversationRowStore()
    read(store, [row()])
    const listing = inFlight(store)

    store.applyActivity(ID, busy)
    store.applyTitle(ID, '帧上的名字')
    expect(store.get(ID)).toMatchObject({ activity: busy, title: '帧上的名字' })

    // 这一页读库早于两帧。
    listing.settle([row({ title: '读库时的名字', updatedAt: '2026-10-01T00:05:00Z' })])

    expect(store.get(ID)).toMatchObject({
      activity: busy,
      title: '帧上的名字',
      updatedAt: '2026-10-01T00:05:00Z',
    })
  })

  it('结果回来、记录本关掉以后，新到的帧照常生效，下一次的结果整行替换', () => {
    const store = new ConversationRowStore()
    const listing = inFlight(store)
    store.applyTitle(ID, '在途时的名字')
    listing.settle([row()])
    expect(store.get(ID)?.title).toBe('在途时的名字')

    store.applyActivity(ID, busy)
    expect(store.get(ID)?.activity).toMatchObject(busy)

    read(store, [row({ activity: { ...row().activity, ...idle }, title: '库里的名字' })])
    expect(store.get(ID)).toMatchObject({ activity: idle, title: '库里的名字' })
  })

  it('两个请求同时在途：各自只重放自己开本以后到达的帧，先关的不影响另一本', () => {
    const store = new ConversationRowStore()
    read(store, [row()])
    const first = inFlight(store)
    store.applyTitle(ID, '甲')
    const second = inFlight(store)
    store.applyActivity(ID, busy)

    // 第一本记着两帧：读库早于它们的结果回来，两帧都重放。
    first.settle([row()])
    expect(store.get(ID)).toMatchObject({ activity: busy, title: '甲' })

    // 第一本已关，第二本还开着：之后的帧只进第二本。
    store.applyTitle(ID, '乙')
    // 第二本开在「甲」之后：它的结果里已经是「甲」，不重放「甲」，只重放忙与「乙」。
    second.settle([row({ title: '甲' })])
    expect(store.get(ID)).toMatchObject({ activity: busy, title: '乙' })
  })

  it('第二本不重放开本之前的帧：结果里已经有它，以结果为准', () => {
    const store = new ConversationRowStore()
    read(store, [row()])
    store.applyTitle(ID, '旧帧')
    const listing = inFlight(store)

    listing.settle([row({ title: '库里更新的名字' })])

    expect(store.get(ID)?.title).toBe('库里更新的名字')
  })

  it('新建 / 修改帧换掉活动以外的字段，不改活动；行不在池里时整行收下', () => {
    const store = new ConversationRowStore()
    store.applyRow(row({ activity: { ...row().activity, ...busy }, title: '新建' }))
    expect(store.get(ID)).toMatchObject({ activity: busy, title: '新建' })

    store.applyActivity(ID, idle)
    // 帧里的活动是写库时读的，比刚到的 work_changed 旧。
    store.applyRow(
      row({
        activity: { ...row().activity, ...busy },
        collectionId: 'c-new',
        completedAt: '2026-10-01T01:00:00Z',
        title: '改名',
      }),
    )

    expect(store.get(ID)).toMatchObject({
      activity: idle,
      collectionId: 'c-new',
      completedAt: '2026-10-01T01:00:00Z',
      title: '改名',
    })
  })

  it('读期间到达的修改帧在结果回来后重放：事实字段不回退，活动以结果为准', () => {
    const store = new ConversationRowStore()
    read(store, [row()])
    const listing = inFlight(store)

    store.applyRow(row({ activity: { ...row().activity, ...busy }, collectionId: 'c-new' }))
    listing.settle([row({ activity: { ...row().activity, ...idle }, collectionId: null })])

    expect(store.get(ID)).toMatchObject({ activity: idle, collectionId: 'c-new' })
  })

  it('行不在池里：有请求在途时标题帧与忙闲帧记下，结果回来后重放', () => {
    const store = new ConversationRowStore()
    const listing = inFlight(store)

    store.applyTitle(ID, '帧上的名字')
    store.applyActivity(ID, busy)
    expect(store.get(ID)).toBeUndefined()

    listing.settle([row()])
    expect(store.get(ID)).toMatchObject({ activity: busy, title: '帧上的名字' })
  })

  it('行不在池里、又没有请求在途：标题帧与忙闲帧丢掉，下一次的结果是准的', () => {
    const store = new ConversationRowStore()

    store.applyTitle(ID, '没人接的名字')
    store.applyActivity(ID, busy)
    expect(store.get(ID)).toBeUndefined()

    read(store, [row({ title: '库里的名字' })])
    expect(store.get(ID)).toMatchObject({
      activity: { busy: false },
      title: '库里的名字',
    })
  })

  it('请求出错或被中止时原样抛出错误，不合并行', async () => {
    const store = new ConversationRowStore()
    const merge = vi.fn()

    await expect(store.track(() => Promise.reject(new Error('读取失败')), merge)).rejects.toThrow(
      '读取失败',
    )
    await expect(
      store.track(() => Promise.reject(new DOMException('中止', 'AbortError')), merge),
    ).rejects.toThrow('中止')

    expect(merge).not.toHaveBeenCalled()
  })

  it('track 在发请求之前开本：请求发出后到达的帧在结果回来后重放，结果交给 merge 后关本', async () => {
    const store = new ConversationRowStore()
    read(store, [row()])
    let respond: (rows: SessionRow[]) => void = () => {}
    const reading = store.track(
      () => new Promise<SessionRow[]>((resolve) => (respond = resolve)),
      (rows, book) => ({ book, merged: store.mergeRows(rows, book) }),
    )

    store.applyTitle(ID, '在途时改的名字')
    respond([row()])
    const { book, merged } = await reading

    expect(merged[0]?.title).toBe('在途时改的名字')
    expect(book.closed).toBe(true)
  })

  it('删除记墓碑：活行不再收、视图里消失；带 deletedAt 的墓碑行（治理者复盘）照收', () => {
    const store = new ConversationRowStore()
    const live = row()
    read(store, [live])

    store.applyDeleted(ID)

    expect(read(store, [row()])).toEqual([])
    expect(store.resolve(live)).toBeNull()
    store.applyRow(row({ title: '删后晚到的整行帧' }))
    expect(store.resolve(live)).toBeNull()
    const tomb = row({ deletedAt: '2026-10-01T02:00:00Z' })
    expect(read(store, [tomb])).toHaveLength(1)
    expect(store.resolveAll([live], true)).toEqual([live])
  })

  it('读期间先来整行帧、再来删除：墓碑行回来时不被重放的活行带回去', () => {
    const store = new ConversationRowStore()
    read(store, [row()])
    const audit = inFlight(store)

    store.applyRow(row({ title: '删之前改的名字' }))
    store.applyDeleted(ID)
    audit.settle([row({ deletedAt: '2026-10-01T02:00:00Z' })])

    expect(store.get(ID)?.deletedAt).toBe('2026-10-01T02:00:00Z')
  })

  it('开跑帧把收尾标记清成空：开跑前读库的行带着旧标记晚到也不复原', () => {
    const store = new ConversationRowStore()
    read(store, [row({ completedAt: '2026-10-01T01:00:00Z' })])
    const listing = inFlight(store)

    store.applyActivity(ID, busy)
    expect(store.get(ID)?.completedAt).toBeNull()
    listing.settle([row({ completedAt: '2026-10-01T01:00:00Z' })])

    expect(store.get(ID)?.completedAt).toBeNull()
  })

  it('没有变化不换引用，一批写入只通知一次', () => {
    const store = new ConversationRowStore()
    const [first] = read(store, [row()])
    const listener = vi.fn()
    store.subscribe(listener)

    const [again] = read(store, [row()])
    expect(again).toBe(first)
    expect(listener).not.toHaveBeenCalled()

    const input = [row()]
    expect(store.resolveAll(input, false)).toBe(store.resolveAll(input, false))

    store.batch(() => {
      store.applyTitle(ID, '甲')
      store.applyActivity(ID, busy)
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('带额外字段的行（全部对话页的素材片地址）解析后保留这些字段，池里只存对话行本身', () => {
    const store = new ConversationRowStore()
    const audit = { ...row(), latestMasterUrl: 'https://cdn.example/a.mp4' }

    const [merged] = read(store, [audit])
    store.applyTitle(ID, '改名')

    expect(merged?.latestMasterUrl).toBe('https://cdn.example/a.mp4')
    expect(store.get(ID)).not.toHaveProperty('latestMasterUrl')
    expect(store.resolve(audit)).toMatchObject({
      latestMasterUrl: 'https://cdn.example/a.mp4',
      title: '改名',
    })
  })
})
