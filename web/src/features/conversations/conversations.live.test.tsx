import { act, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { USER_QUERY_KEY } from '@/shared/auth/session'
import { addMockConversation, loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SERVER_HELLO, sessionEnvelope } from '@/testing/ws'
import { DEFAULT_AUDIT_FILTERS, useAuditConversations } from './audit.api'
import { conversationsQueryKeys, type Conversation } from './conversations.api'
import { conversationRowsOf } from './conversation-rows'
import { useLiveConversations } from './conversations.live'
import { useVideoProgress } from './video-progress.api'

function LiveFrames() {
  useLiveConversations()
  return null
}

/** 全部对话页的那份无限查询；有它挂着，失效才会真的发请求。 */
function AuditList() {
  useAuditConversations(DEFAULT_AUDIT_FILTERS, true)
  return null
}

/** 视频进度查询；同上，挂着才会真的重拉。 */
function VideoProgressList() {
  useVideoProgress()
  return null
}

const AUDIT_KEY = conversationsQueryKeys.audit(DEFAULT_AUDIT_FILTERS)
const SIDEBAR_KEY = conversationsQueryKeys.sidebar('all')
const MORE_KEY = conversationsQueryKeys.more({ state: 'all' })
const VIDEO_PROGRESS_KEY = conversationsQueryKeys.videoProgress
const OTHER_OWNER = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009'

const AUDIT_WINDOW_MS = 1500

const conversationRow = (overrides: Partial<Conversation> = {}): Conversation => {
  const row = addMockConversation('小王的秋季片', '2026-09-20T00:00:00Z', overrides.ownerUserId)
  Object.assign(row, { completedAt: '2026-09-20T01:00:00Z', ...overrides })
  return row
}

/** 照一次读完的 HTTP 请求把行放进池：开本、合并、关本。 */
const mergeRead = (queryClient: QueryClient, rows: Conversation[]): Conversation[] => {
  const store = conversationRowsOf(queryClient)
  const book = store.open()
  const merged = store.mergeRows(rows, book)
  book.close()
  return merged
}

const seedCaches = (queryClient: QueryClient, row: Conversation) => {
  mergeRead(queryClient, [{ ...row }])
  queryClient.setQueryData(AUDIT_KEY, {
    pageParams: [null],
    pages: [{ items: [row], nextCursor: null, runningTotal: 0, total: 1 }],
  })
  queryClient.setQueryData(SIDEBAR_KEY, {
    collections: [],
    ungrouped: { items: [row], nextCursor: 'cursor-1' },
    ungroupedCount: 2,
  })
  queryClient.setQueryData(MORE_KEY, {
    pageParams: [null],
    pages: [{ items: [row], nextCursor: 'cursor-1' }],
  })
  queryClient.setQueryData(VIDEO_PROGRESS_KEY, {})
}

const poolRow = (queryClient: QueryClient, id: string) => conversationRowsOf(queryClient).get(id)

const invalidated = (queryClient: QueryClient, key: readonly unknown[]): boolean =>
  queryClient.getQueryState(key)?.isInvalidated ?? false

const activityFrame = (
  conversationId: string,
  payload: {
    busy: boolean
    pending_interaction?: 'none' | 'approval' | 'question'
    last_turn_reason?: 'completed' | 'failed' | 'aborted'
  },
  owner?: string,
) => ({
  ...sessionEnvelope(conversationId, owner),
  payload: { pending_interaction: 'none', ...payload },
  session_id: conversationId,
  type: 'event.session.work_changed',
})

const titleFrame = (conversationId: string, title: string) => ({
  ...sessionEnvelope(conversationId),
  payload: { title },
  session_id: conversationId,
  type: 'session.meta.updated',
})

const generationFrame = (
  conversationId: string,
  kind: 'video' | 'image',
  {
    owner,
    status = 'submitted',
  }: {
    owner?: string
    status?: 'pending' | 'submitting' | 'submitted' | 'completed' | 'failed'
  } = {},
) => ({
  ...sessionEnvelope(conversationId, owner),
  payload: { id: 'job-1', kind, operation: 'generate', status },
  session_id: conversationId,
  type: 'event.generation.changed',
})

const rowFrame = (
  kind: 'created' | 'updated',
  row: Conversation,
  owner?: string,
): Record<string, unknown> => ({
  ...sessionEnvelope(row.id, owner),
  payload: { ...row },
  session_id: row.id,
  type: `event.session.${kind}`,
})

const deletedFrame = (conversationId: string) => ({
  ...sessionEnvelope(conversationId),
  session_id: conversationId,
  type: 'event.session.deleted',
})

const countRowReads = () => {
  const reads: string[] = []
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && /^\/api\/conversations\/[0-9a-f-]{36}$/.test(path)) {
      reads.push(path)
    }
  })
  return reads
}

const mount = async () => {
  loginAs(mockAuthUser)
  const rendered = await renderWithProviders(<LiveFrames />)
  await waitFor(() => expect(rendered.queryClient.getQueryData(USER_QUERY_KEY)).toBeTruthy())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return rendered
}

const settle = (ms = AUDIT_WINDOW_MS) =>
  act(async () => {
    await Promise.resolve()
    vi.advanceTimersByTime(ms)
  })

afterEach(() => {
  vi.useRealTimers()
  server.events.removeAllListeners()
})

describe('useLiveConversations', () => {
  it('自己对话的开跑帧改池里的行、抹掉收尾标记，重拉全部对话页并补读这一行，不动侧栏', async () => {
    const row = conversationRow()
    const reads = countRowReads()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    row.activity = { ...row.activity, busy: true }
    row.completedAt = null
    socket.deliver(activityFrame(row.id, { busy: true }))
    await settle()

    expect(poolRow(queryClient, row.id)).toMatchObject({
      activity: { busy: true, pendingInteraction: 'none' },
      completedAt: null,
    })
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
    await vi.waitFor(() => expect(reads).toEqual([`/api/conversations/${row.id}`]))
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
    expect(invalidated(queryClient, MORE_KEY)).toBe(false)
  })

  it('活动帧触发的单行补读以最后一次为准：同一拍的帧只读一次，在途时再来的帧中止旧读并重读', async () => {
    const frame = (id: string, index: number) =>
      activityFrame(
        id,
        index % 2 === 0 ? { busy: true } : { busy: false, last_turn_reason: 'failed' },
      )
    const row = conversationRow({
      activity: { busy: false, lastTurnReason: null, pendingInteraction: 'none' },
    })
    const reads: string[] = []
    const aborted: boolean[] = []
    const gates: (() => void)[] = []
    server.use(
      http.get('*/api/conversations/:conversationId', async ({ params, request }) => {
        reads.push(String(params['conversationId']))
        await new Promise<void>((resolve) => gates.push(resolve))
        aborted.push(request.signal.aborted)
        return HttpResponse.json({ conversation: row })
      }),
    )
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(frame(row.id, 0))
    socket.deliver(frame(row.id, 1))
    await settle(0)
    expect(reads).toEqual([row.id])

    socket.deliver(frame(row.id, 2))
    await settle(0)
    await vi.waitFor(() => expect(reads).toEqual([row.id, row.id]))
    for (const release of gates) release()
    await vi.waitFor(() => expect(aborted).toEqual([true, false]))

    socket.deliver(frame(row.id, 3))
    await settle(0)
    await vi.waitFor(() => expect(reads).toHaveLength(3))
  })

  it('在途那次读到的旧值进不了池：后一次读到的行留在池里', async () => {
    const row = conversationRow({
      activity: { busy: false, lastTurnReason: null, pendingInteraction: 'none' },
      lastRunId: 'run-1',
    })
    const gates: (() => void)[] = []
    let responded = 0
    server.use(
      http.get('*/api/conversations/:conversationId', async () => {
        const snapshot = { ...row, activity: { ...row.activity } }
        await new Promise<void>((resolve) => gates.push(resolve))
        responded += 1
        return HttpResponse.json({ conversation: snapshot })
      }),
    )
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    row.lastRunId = 'run-2'
    socket.deliver(activityFrame(row.id, { busy: true }))
    await settle(0)
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    row.lastRunId = 'run-3'
    socket.deliver(activityFrame(row.id, { busy: false, last_turn_reason: 'completed' }))
    await settle(0)
    await vi.waitFor(() => expect(gates).toHaveLength(2))

    gates[1]?.()
    await vi.waitFor(() => expect(poolRow(queryClient, row.id)?.lastRunId).toBe('run-3'))
    gates[0]?.()
    await vi.waitFor(() => expect(responded).toBe(2))
    await settle(0)
    expect(poolRow(queryClient, row.id)?.lastRunId).toBe('run-3')
  })

  it('轮状态没变的活动帧不补读', async () => {
    const row = conversationRow({
      activity: { busy: true, lastTurnReason: null, pendingInteraction: 'none' },
    })
    const reads = countRowReads()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(activityFrame(row.id, { busy: true }))
    await settle()

    expect(reads).toEqual([])
  })

  it('开跑的 updated 帧带出新的 lastRunId 与空收尾标记，读期间到达的帧盖得住晚回来的旧行', async () => {
    const row = conversationRow()
    server.use(http.get('*/api/conversations/:conversationId', () => new Promise<never>(() => {})))
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)
    // 一次列表请求在途：读库早于下面两帧。
    const rows = conversationRowsOf(queryClient)
    const book = rows.open()
    const stale = { ...row }

    row.activity = { ...row.activity, busy: true }
    socket.deliver(activityFrame(row.id, { busy: true }))
    Object.assign(row, { completedAt: null, lastRunId: 'run-9' })
    socket.deliver(rowFrame('updated', row))
    await settle()
    rows.mergeRows([stale], book)
    book.close()

    expect(poolRow(queryClient, row.id)).toMatchObject({
      activity: { busy: true },
      completedAt: null,
      lastRunId: 'run-9',
    })
  })

  it('改名帧只换标题，不动分页也不重拉任何列表', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(titleFrame(row.id, '改过的名字'))
    await settle()

    expect(poolRow(queryClient, row.id)).toMatchObject({
      completedAt: row.completedAt,
      title: '改过的名字',
    })
    expect(invalidated(queryClient, MORE_KEY)).toBe(false)
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
  })

  it('自己对话的视频帧在窗口到期后让视频进度重拉，不补读行，也不重拉分页与拓扑', async () => {
    const row = conversationRow()
    const reads = countRowReads()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(generationFrame(row.id, 'video'))
    await settle(0)
    expect(invalidated(queryClient, VIDEO_PROGRESS_KEY)).toBe(false)
    await settle()

    expect(invalidated(queryClient, VIDEO_PROGRESS_KEY)).toBe(true)
    expect(reads).toEqual([])
    expect(invalidated(queryClient, MORE_KEY)).toBe(false)
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
  })

  it('没挂对话的视频帧不重拉视频进度', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    // 没有来源对话的任务帧不带 session_id（合同 §5「全局帧」）。
    socket.deliver({
      ...sessionEnvelope(row.id),
      payload: { id: 'job-1', kind: 'video', operation: 'enhance', status: 'submitted' },
      type: 'event.generation.changed',
    })
    await settle()

    expect(invalidated(queryClient, VIDEO_PROGRESS_KEY)).toBe(false)
  })

  it('视频出完了但全部对话页没列着这段对话：不为它重拉全部对话页', async () => {
    const listed = conversationRow()
    const unlisted = conversationRow({ title: '没在全部对话页里的片' })
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, listed)
    mergeRead(queryClient, [{ ...unlisted }])

    socket.deliver(generationFrame(unlisted.id, 'video', { status: 'completed' }))
    await settle()

    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
  })

  it('图片帧不上行：不补读、不重拉，视频进度也不动', async () => {
    const row = conversationRow()
    const reads = countRowReads()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(generationFrame(row.id, 'image'))
    await settle()

    expect(reads).toEqual([])
    expect(poolRow(queryClient, row.id)?.completedAt).toBe(row.completedAt)
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
    expect(invalidated(queryClient, VIDEO_PROGRESS_KEY)).toBe(false)
  })

  it('重连后原位重拉分页、拓扑、全部对话页与视频进度，已读的分页留着', async () => {
    const row = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.onclose?.()
    await settle(2000)
    socket.deliver(SERVER_HELLO)
    await settle()

    expect(invalidated(queryClient, MORE_KEY)).toBe(true)
    expect(queryClient.getQueryData(MORE_KEY)).toBeDefined()
    expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(true)
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
    expect(invalidated(queryClient, VIDEO_PROGRESS_KEY)).toBe(true)
  })

  describe('别人的对话（治理者的连接收全平台的帧）', () => {
    it.each([
      [
        '跑完一轮',
        (id: string) =>
          activityFrame(id, { busy: false, last_turn_reason: 'completed' }, OTHER_OWNER),
      ],
      ['视频任务跳状态', (id: string) => generationFrame(id, 'video', { owner: OTHER_OWNER })],
    ])('%s：不重拉自己的侧栏，也不重拉已展开的分页', async (_label, frame) => {
      const mine = conversationRow()
      const { queryClient, socket } = await mount()
      seedCaches(queryClient, mine)
      const theirs = conversationRow({ ownerUserId: OTHER_OWNER })

      socket.deliver(frame(theirs.id))
      await settle()

      expect(invalidated(queryClient, MORE_KEY)).toBe(false)
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
    })

    it('别人的新建与删除只牵动全部对话页', async () => {
      const mine = conversationRow()
      const { queryClient, socket } = await mount()
      seedCaches(queryClient, mine)
      const theirs = conversationRow({ ownerUserId: OTHER_OWNER })

      socket.deliver(rowFrame('created', theirs, OTHER_OWNER))
      await settle()

      expect(poolRow(queryClient, theirs.id)?.title).toBe(theirs.title)
      expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
      expect(invalidated(queryClient, MORE_KEY)).toBe(false)
    })
  })

  describe('行的新建、变化与删除', () => {
    it('别处新建了自己的对话：行进池，侧栏重拉让它出现', async () => {
      const mine = conversationRow()
      const { queryClient, socket } = await mount()
      seedCaches(queryClient, mine)
      const created = conversationRow({ completedAt: null, title: '另一个窗口建的' })

      socket.deliver(rowFrame('created', created))
      await settle()

      expect(poolRow(queryClient, created.id)?.title).toBe('另一个窗口建的')
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(true)
    })

    it('换了合集重拉侧栏；只换收尾标记只重算按状态筛选的列表；只改名什么都不重拉', async () => {
      const row = conversationRow()
      const { queryClient, socket } = await mount()
      seedCaches(queryClient, row)
      const OPEN_SIDEBAR_KEY = conversationsQueryKeys.sidebar('open')
      queryClient.setQueryData(OPEN_SIDEBAR_KEY, {
        collections: [],
        ungrouped: { items: [row], nextCursor: null },
        ungroupedCount: 1,
      })

      socket.deliver(rowFrame('updated', { ...row, title: '只改名' }))
      await settle()
      expect(poolRow(queryClient, row.id)?.title).toBe('只改名')
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
      expect(invalidated(queryClient, OPEN_SIDEBAR_KEY)).toBe(false)

      socket.deliver(rowFrame('updated', { ...row, completedAt: null, title: '只改名' }))
      await settle()
      expect(poolRow(queryClient, row.id)?.completedAt).toBeNull()
      expect(invalidated(queryClient, OPEN_SIDEBAR_KEY)).toBe(true)
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)

      const collectionId = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff00c1'
      socket.deliver(rowFrame('updated', { ...row, collectionId, completedAt: null }))
      await settle()
      expect(poolRow(queryClient, row.id)?.collectionId).toBe(collectionId)
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(true)
    })

    it('别处删掉了：记墓碑，侧栏重拉计数；晚到的旧行不会把它带回来', async () => {
      const row = conversationRow()
      const { queryClient, socket } = await mount()
      seedCaches(queryClient, row)

      socket.deliver(deletedFrame(row.id))
      await settle()

      const rows = conversationRowsOf(queryClient)
      expect(rows.isDeleted(row.id)).toBe(true)
      expect(mergeRead(queryClient, [{ ...row }])).toEqual([])
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(true)
    })
  })

  describe('忙闲变化与筛选列表', () => {
    const OPEN_SIDEBAR_KEY = conversationsQueryKeys.sidebar('open')
    const OPEN_MORE_KEY = conversationsQueryKeys.more({ state: 'open' })

    const seedFiltered = (queryClient: QueryClient, row: Conversation) => {
      seedCaches(queryClient, row)
      queryClient.setQueryData(OPEN_SIDEBAR_KEY, {
        collections: [],
        ungrouped: { items: [row], nextCursor: null },
        ungroupedCount: 1,
      })
      queryClient.setQueryData(OPEN_MORE_KEY, {
        pageParams: [null],
        pages: [{ items: [row], nextCursor: null }],
      })
    }

    it('自己的对话只让非 all 的筛选重算：原位重拉筛选下的分页与拓扑', async () => {
      const row = conversationRow()
      const { queryClient, socket } = await mount()
      seedFiltered(queryClient, row)

      socket.deliver(activityFrame(row.id, { busy: true }))
      await settle()

      expect(invalidated(queryClient, OPEN_SIDEBAR_KEY)).toBe(true)
      expect(invalidated(queryClient, OPEN_MORE_KEY)).toBe(true)
      expect(queryClient.getQueryData(OPEN_MORE_KEY)).toBeDefined()
      expect(invalidated(queryClient, SIDEBAR_KEY)).toBe(false)
      expect(invalidated(queryClient, MORE_KEY)).toBe(false)
    })

    it('轮状态没变的活动帧不重算筛选列表', async () => {
      const row = conversationRow({
        activity: { busy: true, lastTurnReason: null, pendingInteraction: 'none' },
      })
      const { queryClient, socket } = await mount()
      seedFiltered(queryClient, row)

      socket.deliver(activityFrame(row.id, { busy: true }))
      await settle()

      expect(invalidated(queryClient, OPEN_SIDEBAR_KEY)).toBe(false)
      expect(invalidated(queryClient, OPEN_MORE_KEY)).toBe(false)
    })

    it('别人的对话只改池里的行，不动自己的筛选列表', async () => {
      const row = conversationRow({ ownerUserId: OTHER_OWNER })
      const { queryClient, socket } = await mount()
      seedFiltered(queryClient, row)

      socket.deliver(activityFrame(row.id, { busy: true }, OTHER_OWNER))
      await settle()

      expect(poolRow(queryClient, row.id)?.activity.busy).toBe(true)
      expect(invalidated(queryClient, OPEN_SIDEBAR_KEY)).toBe(false)
      expect(invalidated(queryClient, OPEN_MORE_KEY)).toBe(false)
    })
  })

  it('只有待办变化的帧改池里的行就够，不重拉全部对话页', async () => {
    const row = conversationRow({
      activity: { busy: true, lastTurnReason: null, pendingInteraction: 'none' },
    })
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    row.activity = { ...row.activity, pendingInteraction: 'approval' }
    socket.deliver(activityFrame(row.id, { busy: true, pending_interaction: 'approval' }))
    await settle()

    expect(poolRow(queryClient, row.id)?.activity.pendingInteraction).toBe('approval')
    expect(invalidated(queryClient, AUDIT_KEY)).toBe(false)
  })

  it.each([
    [
      '忙闲相对池里的行翻转',
      { busy: true } as const,
      { busy: false, lastTurnReason: null, pendingInteraction: 'none' } as const,
    ],
    [
      '这一帧是收尾',
      { busy: false, last_turn_reason: 'completed' } as const,
      { busy: false, lastTurnReason: 'failed', pendingInteraction: 'none' } as const,
    ],
  ])('%s 时重拉全部对话页', async (_label, frame, cachedActivity) => {
    const row = conversationRow({ activity: { ...cachedActivity } })
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, row)

    socket.deliver(activityFrame(row.id, frame))
    await settle()

    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
  })

  it('池里没有这段对话时重拉，让它出现在全部对话页', async () => {
    const cached = conversationRow()
    const fresh = conversationRow()
    const { queryClient, socket } = await mount()
    seedCaches(queryClient, cached)

    socket.deliver(activityFrame(fresh.id, { busy: false, last_turn_reason: 'aborted' }))
    await settle()

    expect(invalidated(queryClient, AUDIT_KEY)).toBe(true)
  })

  it('一阵帧只重拉一次全部对话页', async () => {
    const reads: string[] = []
    loginAs(mockAuthUser)
    server.use(
      http.get('*/api/conversations/audit', ({ request }) => {
        reads.push(new URL(request.url).search)
        return HttpResponse.json({ items: [], nextCursor: null, runningTotal: 0, total: 0 })
      }),
    )
    const { queryClient, socket } = await renderWithProviders(
      <>
        <LiveFrames />
        <AuditList />
      </>,
    )
    await waitFor(() => expect(queryClient.getQueryData(USER_QUERY_KEY)).toBeTruthy())
    await waitFor(() => expect(reads).toHaveLength(1))

    for (let index = 0; index < 5; index += 1) {
      socket.deliver(activityFrame(conversationRow().id, { busy: true }))
    }

    await waitFor(() => expect(reads).toHaveLength(2), { timeout: 3000 })
    await new Promise((resolve) => setTimeout(resolve, AUDIT_WINDOW_MS))
    expect(reads).toHaveLength(2)
  }, 10_000)

  it('一阵视频帧（治理者还收别人对话的）只重拉一次视频进度，不补读行', async () => {
    let progressReads = 0
    const rowReads = countRowReads()
    loginAs(mockAuthUser)
    server.use(
      http.get('*/api/conversations/video-progress', () => {
        progressReads += 1
        return HttpResponse.json({ conversations: {} })
      }),
    )
    const { queryClient, socket } = await renderWithProviders(
      <>
        <LiveFrames />
        <VideoProgressList />
      </>,
    )
    await waitFor(() => expect(queryClient.getQueryData(USER_QUERY_KEY)).toBeTruthy())
    await waitFor(() => expect(progressReads).toBe(1))

    for (let index = 0; index < 5; index += 1) {
      const owner = index % 2 === 0 ? {} : { owner: OTHER_OWNER }
      socket.deliver(generationFrame(conversationRow().id, 'video', owner))
    }

    await waitFor(() => expect(progressReads).toBe(2), { timeout: 3000 })
    await new Promise((resolve) => setTimeout(resolve, AUDIT_WINDOW_MS))
    expect(progressReads).toBe(2)
    expect(rowReads).toEqual([])
  }, 10_000)
})
