import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { mockLibraryVersionIds, mockLibraryVideos } from '@/testing/mocks/library'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { stubScrollViewport } from '@/testing/scroll-viewport'
import { DEFAULT_LIBRARY_SCOPE, libraryQueryKeys, type LibraryScope } from '../library.api'
import { LibraryRoute } from './library-route'

function Harness({
  onScope,
  initialVideo = null,
  version = null,
}: {
  onScope?: (scope: LibraryScope) => void
  initialVideo?: string | null
  version?: string | null
}) {
  const [scope, setScope] = useState(DEFAULT_LIBRARY_SCOPE)
  const [videoId, setVideoId] = useState(initialVideo)
  return (
    <LibraryRoute
      myUserName="tester"
      onScopeChange={(next) => {
        onScope?.(next)
        setScope(next)
        setVideoId(null)
      }}
      onVideoChange={setVideoId}
      scope={scope}
      shareLinkOf={(id) => `https://iclip.test/library?video=${id}`}
      tabs={null}
      versionId={version}
      videoId={videoId}
    />
  )
}

const recordListQueries = () => {
  const queries: URLSearchParams[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/library/videos')) queries.push(url.searchParams)
  })
  return queries
}

const cardNames = () =>
  screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))

const SKATE = '滑板女孩 · 厚底靴街拍'
const SANDALS = '春夏凉鞋合集'

const stubLibraryViewport = () =>
  stubScrollViewport({ role: 'main', name: '资料库' }, { width: 1200, height: 900 })

describe('LibraryRoute', () => {
  beforeEach(stubLibraryViewport)

  it('filters by orientation, by me and by a card author', async () => {
    const queries = recordListQueries()
    const onScope = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onScope={onScope} />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('radio', { name: '横版' }))
    await waitFor(() => expect(cardNames()).toEqual(['童鞋海边亲子', '接口提交']))
    expect(queries.at(-1)?.get('orientation')).toBe('landscape')
    expect(screen.getByText('找到 2 条')).toBeVisible()

    await user.click(screen.getByRole('radio', { name: '全部' }))
    await user.click(screen.getByRole('radio', { name: '我生成的' }))
    await waitFor(() => expect(queries.at(-1)?.get('userName')).toBe('tester'))
    expect(queries.at(-1)?.get('orientation')).toBeNull()

    await user.click(screen.getByRole('radio', { name: '全部' }))
    const sandals = await screen.findByRole('article', { name: SANDALS })
    await user.click(within(sandals).getByRole('button', { name: /Nora\.Ho/ }))
    expect(onScope).toHaveBeenLastCalledWith(expect.objectContaining({ userName: 'Nora.Ho' }))
    await waitFor(() => expect(cardNames()).toEqual([SANDALS]))
  })

  it('searches the scripts after typing stops', async () => {
    const queries = recordListQueries()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findAllByRole('article')

    await user.type(screen.getByRole('textbox', { name: '搜索脚本' }), '滑板')

    await waitFor(() => expect(cardNames()).toEqual([SKATE]))
    expect(queries.at(-1)?.get('q')).toBe('滑板')
    expect(queries.filter((query) => query.has('q'))).toHaveLength(1)
  })

  it('copies the full prompt from a card', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: '接口提交' })

    await user.click(within(card).getByRole('button', { name: '复制完整提示词' }))

    await expect(navigator.clipboard.readText()).resolves.toBe(
      '一条横版的纯文本描述，没有分镜结构。',
    )
    expect(within(card).getByRole('button', { name: '已复制完整提示词' })).toBeVisible()
  })

  it('shows a retryable error when the list fails', async () => {
    server.use(
      http.get('*/api/library/videos', () =>
        HttpResponse.json({ detail: '数据库不可用' }, { status: 500 }),
      ),
    )
    await renderWithProviders(<Harness />)

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库不可用')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible()
  })
})

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

const serveThreePages = (
  override?: (cursor: string) => Promise<Response | undefined> | Response | undefined,
) => {
  const [first, second, third] = mockLibraryVideos()
  server.use(
    http.get('*/api/library/videos', async ({ request }) => {
      const url = new URL(request.url)
      if (url.searchParams.get('q') === '没有的词')
        return HttpResponse.json({ items: [], nextCursor: null, total: 0 })
      const cursor = url.searchParams.get('cursor')
      if (cursor === null) return HttpResponse.json({ items: [first], nextCursor: 'p2', total: 3 })
      const replaced = await override?.(cursor)
      if (replaced !== undefined) return replaced
      return cursor === 'p2'
        ? HttpResponse.json({ items: [second], nextCursor: 'p3', total: null })
        : HttpResponse.json({ items: [third], nextCursor: null, total: null })
    }),
  )
}

const cursorsOf = (queries: URLSearchParams[]) => queries.map((query) => query.get('cursor'))

describe('library paging', () => {
  beforeEach(stubLibraryViewport)
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps reading while the footer stays near the bottom, stops at the last page and says when nothing matches', async () => {
    const queries = recordListQueries()
    serveThreePages()
    stubIntersectionObserver({ inRange: true })
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(3))
    expect(cursorsOf(queries)).toEqual([null, 'p2', 'p3'])
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await settle()
    expect(queries).toHaveLength(3)

    await user.type(screen.getByRole('textbox', { name: '搜索脚本' }), '没有的词')
    expect(await screen.findByText(/暂无匹配的视频/)).toBeVisible()
  })

  it('waits for the footer to near the bottom, and starts over from the first page after a filter change', async () => {
    const queries = recordListQueries()
    serveThreePages()
    const viewport = stubIntersectionObserver()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    await screen.findAllByRole('article')
    expect(screen.getByText('已显示 1 / 3')).toBeVisible()
    await settle()
    expect(cursorsOf(queries)).toEqual([null])

    await viewport.scroll(true)
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(3))
    expect(cursorsOf(queries)).toEqual([null, 'p2', 'p3'])

    await user.click(screen.getByRole('radio', { name: '横版' }))
    await waitFor(() => expect(queries).toHaveLength(6))
    expect(queries.slice(3).map((query) => query.get('orientation'))).toEqual([
      'landscape',
      'landscape',
      'landscape',
    ])
    expect(cursorsOf(queries.slice(3))).toEqual([null, 'p2', 'p3'])
  })

  it('stops after a failed page and resumes once it is retried', async () => {
    const queries = recordListQueries()
    let failing = true
    serveThreePages((cursor) =>
      cursor === 'p2' && failing
        ? HttpResponse.json({ detail: '数据库不可用' }, { status: 500 })
        : undefined,
    )
    const viewport = stubIntersectionObserver({ inRange: true })
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库不可用')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    await viewport.scroll(true)
    await settle()
    expect(cursorsOf(queries)).toEqual([null, 'p2'])

    failing = false
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(3))
    expect(cursorsOf(queries)).toEqual([null, 'p2', 'p2', 'p3'])
  })

  it('shares one request when the viewer reaches the loaded end while the footer is near', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const queries = recordListQueries()
    serveThreePages()
    stubIntersectionObserver({ inRange: true })
    const [first] = mockLibraryVideos()
    const user = userEvent.setup()
    await renderWithProviders(<Harness initialVideo={first?.id ?? null} />)

    await screen.findByRole('dialog', { name: '跑鞋手持展示' })
    await waitFor(() => expect(cursorsOf(queries)).toEqual([null, 'p2', 'p3']))
    await settle()
    expect(queries).toHaveLength(3)
    await user.keyboard('{ArrowRight}')
    expect(await screen.findByRole('dialog', { name: SKATE })).toBeVisible()
  })

  it('reads the next page once a background refresh ends while the viewer sits on the loaded end', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const queries = recordListQueries()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstPageReads = 0
    const [first, second] = mockLibraryVideos()
    server.use(
      http.get('*/api/library/videos', async ({ request }) => {
        if (new URL(request.url).searchParams.has('cursor'))
          return HttpResponse.json({ items: [second], nextCursor: null, total: null })
        firstPageReads += 1
        if (firstPageReads > 1) await held
        return HttpResponse.json({ items: [first], nextCursor: 'p2', total: 2 })
      }),
    )
    stubIntersectionObserver()
    const user = userEvent.setup()
    const { queryClient } = await renderWithProviders(<Harness />)
    await screen.findByRole('article', { name: '跑鞋手持展示' })

    void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.videos(DEFAULT_LIBRARY_SCOPE) })
    await waitFor(() => expect(cursorsOf(queries)).toEqual([null, null]))
    const viewer = await openCard(user, '跑鞋手持展示')
    const next = within(viewer).getByRole('button', { name: '下一条' })
    await settle()
    expect(cursorsOf(queries)).toEqual([null, null])
    expect(next).toHaveAttribute('aria-disabled', 'true')

    release()
    await waitFor(() => expect(cursorsOf(queries)).toEqual([null, null, 'p2']))
    await waitFor(() => expect(next).not.toHaveAttribute('aria-disabled'))
    await user.click(next)
    expect(await screen.findByRole('dialog', { name: SKATE })).toBeVisible()
  })
})

const openCard = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  const card = await screen.findByRole('article', { name: title })
  await user.click(within(card).getByRole('button', { name: `查看详情：${title}` }))
  return screen.findByRole('dialog', { name: title })
}

const playerIn = (viewer: HTMLElement, title: string) =>
  within(viewer).getByLabelText<HTMLVideoElement>(title, { selector: 'video' })

describe('library viewer', () => {
  beforeEach(() => {
    stubLibraryViewport()
    // jsdom 不播放媒体，play / pause 换成立即完成。
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  it('opens on the version given in the address, and its 爆款素材 tab is about that version', async () => {
    const card = mockLibraryVideos().find((video) => video.title === SKATE)
    const second = mockLibraryVersionIds(SKATE)[1]
    if (card === undefined || second === undefined) throw new Error('滑板女孩至少要有两版')
    const stateReads: string[] = []
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname
      if (path.includes('/library/hit-cases/')) stateReads.push(path.split('/').at(-1) ?? '')
    })
    const user = userEvent.setup()
    await renderWithProviders(<Harness initialVideo={card.id} version={second} />)

    const viewer = await screen.findByRole('dialog', { name: SKATE })
    const versions = await within(viewer).findByRole('group', { name: '该镜头组的版本' })
    expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('2')

    await user.click(within(viewer).getByRole('tab', { name: '爆款素材' }))
    expect(await within(viewer).findByRole('button', { name: '加入爆款素材库' })).toBeVisible()
    // 只问过地址里那一版，没问过卡面那一版。
    expect(new Set(stateReads)).toEqual(new Set([second]))
  })

  it('opens a card with every version of its shot group and seeks to a cut', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, SKATE)
    const versions = await within(viewer).findByRole('group', { name: '该镜头组的版本' })
    expect(within(versions).getAllByRole('button')).toHaveLength(6)
    expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('6')
    expect(within(viewer).queryByRole('group', { name: '镜头组' })).not.toBeInTheDocument()

    await user.click(within(viewer).getByRole('button', { name: '镜头 3，1.9 秒起' }))
    expect(playerIn(viewer, SKATE).currentTime).toBeCloseTo(1.95)
    await user.click(within(versions).getByRole('button', { name: '1' }))
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).getByText('第 1 版', { selector: 'dd' })).toBeVisible()
  })

  it('offers the source conversation only to readers who can open it', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithProviders(<Harness />)
    const own = mockLibraryVideos().find((video) => video.canOpenConversation)

    let viewer = await openCard(user, '跑鞋手持展示')
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).getByRole('link', { name: '跑鞋手持展示' })).toHaveAttribute(
      'href',
      `/c/${own?.conversationId}`,
    )
    await user.click(within(viewer).getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '复制链接' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(
      `https://iclip.test/library?video=${own?.id}`,
    )
    await user.click(within(viewer).getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '打开来源任务' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${own?.conversationId}`))

    await user.keyboard('{Escape}')
    expect(mockLibraryVideos().find((video) => video.title === SANDALS)).toMatchObject({
      canOpenConversation: false,
      conversationId: expect.any(String),
    })
    viewer = await openCard(user, SANDALS)
    await user.click(within(viewer).getByRole('button', { name: '更多操作' }))
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
    await user.keyboard('{Escape}')
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).queryByText('来源对话')).not.toBeInTheDocument()
  })

  it('steps through loaded cards with the arrow keys and hands focus back on close', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    await openCard(user, SKATE)
    await user.keyboard('{ArrowRight}')
    const next = await screen.findByRole('dialog', { name: '童鞋海边亲子' })
    await user.keyboard('{Escape}')

    await waitFor(() => expect(next).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '查看详情：童鞋海边亲子' })).toHaveFocus()
  })

  it('leaves the arrow keys to the player while focus is inside it', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, SKATE)
    const player = playerIn(viewer, SKATE)
    Object.defineProperty(player, 'duration', { configurable: true, value: 6 })
    fireEvent.loadedMetadata(player)
    act(() => within(viewer).getByRole('button', { name: '播放' }).focus())
    await user.keyboard('{ArrowRight}')

    expect(player.currentTime).toBe(5)
    expect(screen.getByRole('dialog', { name: SKATE })).toBe(viewer)
  })

  it('expands the player into a lightbox on top and writes its position back on close', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, SKATE)
    const player = playerIn(viewer, SKATE)
    player.currentTime = 1.5
    await user.click(within(viewer).getByRole('button', { name: '放大' }))
    const lightbox = screen.getByRole('dialog', { name: SKATE })
    expect(lightbox).not.toBe(viewer)
    const enlarged = within(lightbox).getByLabelText<HTMLVideoElement>(SKATE, {
      selector: 'video',
    })
    fireEvent.loadedMetadata(enlarged)
    expect(enlarged.currentTime).toBe(1.5)

    enlarged.currentTime = 4
    await user.keyboard('{Escape}')
    expect(lightbox).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: SKATE })).toBe(viewer)
    expect(player.currentTime).toBe(4)
  })

  it('leaves the arrow keys to a reference image opened on top', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, '跑鞋手持展示')
    await user.click(within(viewer).getByRole('button', { name: '查看参考图 1' }))
    await screen.findByRole('dialog', { name: '参考图 1' })
    await user.keyboard('{ArrowRight}')

    expect(within(viewer).getByText('跑鞋手持展示', { selector: 'h2' })).toBeVisible()
    expect(screen.getByRole('dialog', { name: '参考图 1' })).toBeVisible()
  })

  it('filters by the author picked in the viewer and closes it', async () => {
    const onScope = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onScope={onScope} />)

    const viewer = await openCard(user, SANDALS)
    await user.click(within(viewer).getByRole('button', { name: /^Nora\.Ho/ }))

    expect(onScope).toHaveBeenLastCalledWith(expect.objectContaining({ userName: 'Nora.Ho' }))
    await waitFor(() => expect(viewer).not.toBeInTheDocument())
  })

  it('switches shot groups and their versions from the bar under the video', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, SANDALS)
    const groups = await within(viewer).findByRole('group', { name: '镜头组' })
    expect(within(groups).getByRole('button', { pressed: true })).toHaveAccessibleName('1')
    expect(within(viewer).queryByRole('group', { name: '该镜头组的版本' })).not.toBeInTheDocument()

    await user.click(within(groups).getByRole('button', { name: '2' }))
    const versions = await within(viewer).findByRole('group', { name: '该镜头组的版本' })
    expect(within(versions).getAllByRole('button')).toHaveLength(2)
    expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('2')
    expect(within(viewer).getByText('居家客厅，几何地毯与木柜；自然窗光。')).toBeVisible()

    await user.click(within(versions).getByRole('button', { name: '1' }))
    expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('1')
    expect(within(groups).getByRole('button', { pressed: true })).toHaveAccessibleName('2')
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).getByText('第 1 版', { selector: 'dd' })).toBeVisible()
    expect(screen.getByRole('dialog', { name: SANDALS })).toBe(viewer)

    await user.click(within(groups).getByRole('button', { name: '1' }))
    expect(within(viewer).queryByRole('group', { name: '该镜头组的版本' })).not.toBeInTheDocument()
  })

  it('holds the bar row while the detail is on its way, only for cards that will show it', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // 挂住详情；放行后不回响应，交给默认的 mock。
    server.use(
      http.get('*/api/library/videos/:id', async () => {
        await held
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    let viewer = await openCard(user, '跑鞋手持展示')
    expect(within(viewer).queryByRole('status')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    viewer = await openCard(user, SKATE)
    expect(within(viewer).getByRole('status')).toBeInTheDocument()
    expect(within(viewer).queryByRole('group', { name: '该镜头组的版本' })).not.toBeInTheDocument()

    release()
    expect(await within(viewer).findByRole('group', { name: '该镜头组的版本' })).toBeInTheDocument()
    expect(within(viewer).queryByRole('status')).not.toBeInTheDocument()
  })

  it('holds 做同款 until the detail says it can, then goes home with the card', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // 挂住详情；放行后不回响应，交给默认的 mock（挂着对话的卡做得了同款）。
    server.use(
      http.get('*/api/library/videos/:id', async () => {
        await held
      }),
    )
    const user = userEvent.setup()
    const { router } = await renderWithProviders(<Harness />)
    const viewer = await openCard(user, '跑鞋手持展示')
    const card = mockLibraryVideos().find((video) => video.title === '跑鞋手持展示')

    const pending = within(viewer).getByRole('button', { name: '做同款' })
    expect(pending).toHaveAttribute('aria-disabled', 'true')
    act(() => pending.focus())
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    release()
    await waitFor(() =>
      expect(within(viewer).getByRole('button', { name: '做同款' })).not.toHaveAttribute(
        'aria-disabled',
      ),
    )
    await user.click(within(viewer).getByRole('button', { name: '做同款' }))
    expect(router.state.location.pathname).toBe('/')
    expect(router.state.location.search).toEqual({ same: card?.id })
  })

  it('explains why a card cannot be made the same way, on focus and on click', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithProviders(<Harness />)
    // 不挂对话的卡没有对话可拷，做不了同款。
    const viewer = await openCard(user, '接口提交')
    // 只有一组一版，没有镜头组那一行；等「版本」出现，就是详情读回来了。
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    await within(viewer).findByText('第 1 版', { selector: 'dd' })
    const search = router.state.location.search

    const make = within(viewer).getByRole('button', { name: '做同款' })
    expect(make).toHaveAttribute('aria-disabled', 'true')
    act(() => make.focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '该视频没有可用的制作文件，无法做同款',
    )
    act(() => make.blur())
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())

    await user.click(make)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '该视频没有可用的制作文件，无法做同款',
    )
    expect(screen.getByRole('dialog', { name: '接口提交' })).toBe(viewer)
    expect(router.state.location.search).toEqual(search)
  })

  it('copies the prompt of the version on screen', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const viewer = await openCard(user, '跑鞋手持展示')
    const listed = mockLibraryVideos().find((video) => video.title === '跑鞋手持展示')

    await user.click(within(viewer).getByRole('button', { name: '复制提示词' }))

    await expect(navigator.clipboard.readText()).resolves.toBe(listed?.take.prompt)
    expect(within(viewer).getByRole('button', { name: '已复制' })).toBeVisible()
  })

  it('opens a shared link outside the loaded list and says when the video is gone', async () => {
    server.use(
      http.get('*/api/library/videos', () =>
        HttpResponse.json({ items: [], nextCursor: null, total: 0 }),
      ),
    )
    const shared = mockLibraryVideos().find((video) => video.title === SKATE)
    await renderWithProviders(<Harness initialVideo={shared?.id ?? null} />)
    expect(await screen.findByRole('dialog', { name: SKATE })).toBeVisible()
    cleanup()

    await renderWithProviders(<Harness initialVideo="7a1c0000-0000-4000-8000-00000000ffff" />)
    const dialog = await screen.findByRole('dialog', { name: '资料库详情' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('资料库里没有这条视频')
    expect(within(dialog).getByRole('button', { name: '重试' })).toBeVisible()
  })
})

describe('library storyboard', () => {
  beforeEach(() => {
    stubLibraryViewport()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    // 能悬停时卡片会挂预览视频，卸载时清地址要调 load。
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  })

  it('opens as a bottom sheet where hovering is impossible, never the popover, and starts the viewer at the picked cut', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: SKATE })

    await user.click(within(card).getByRole('button', { name: '故事板：4 镜，0:06' }))
    const sheet = await screen.findByRole('dialog', { name: '故事板' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(screen.getAllByRole('dialog', { name: '故事板' })).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: '故事板' })).toBe(sheet)
    expect(within(sheet).getAllByRole('button', { name: /^镜头 \d/ })).toHaveLength(4)
    await user.click(within(sheet).getByRole('button', { name: '镜头 3，1.9 秒起，打开详情' }))

    const viewer = await screen.findByRole('dialog', { name: SKATE })
    expect(sheet).not.toBeInTheDocument()
    const player = playerIn(viewer, SKATE)
    fireEvent.loadedMetadata(player)
    expect(player.currentTime).toBeCloseTo(1.95)
  })

  it('shows on hover, follows the pointer across frames and keeps the wheel to itself', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) => ({ matches: query.includes('(hover: hover)'), media: query }) as MediaQueryList,
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: SKATE })

    await user.hover(within(card).getByRole('button', { name: '故事板：4 镜，0:06' }))
    const popover = await screen.findByRole('dialog', { name: '故事板' })
    expect(popover).toHaveTextContent('镜头 1')
    const third = within(popover).getByRole('button', { name: '镜头 3，1.9 秒起，打开详情' })
    await user.hover(third)
    expect(popover).toHaveTextContent(/镜头 3.*她把滑板竖抱在身前/)

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    third.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)

    await user.unhover(third)
    await waitFor(() => expect(popover).not.toBeInTheDocument())
  })
})
