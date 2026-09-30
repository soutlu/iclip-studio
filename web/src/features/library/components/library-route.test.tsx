import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { mockLibraryVideos } from '@/testing/mocks/library'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_LIBRARY_SCOPE, type LibraryScope } from '../library.api'
import { LibraryRoute } from './library-route'

/** 测试壳持有筛选范围与打开着的详情，与路由把两者存在查询参数里的归属一致：改筛选时详情随之关掉。 */
function Harness({
  onScope,
  initialVideo = null,
}: {
  onScope?: (scope: LibraryScope) => void
  initialVideo?: string | null
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
      videoId={videoId}
    />
  )
}

/** 记下每次列表请求的查询串。 */
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

/** jsdom 没有排版，元素尺寸都是 0；给页面滚动容器一个视口大小，虚拟列表才会渲染视口里的卡片。 */
const stubScrollViewport = () => {
  const sizeOf = (element: HTMLElement, size: number) => (element.tagName === 'MAIN' ? size : 0)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return sizeOf(this, 900)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return sizeOf(this, 1200)
  })
}

describe('LibraryRoute', () => {
  beforeEach(stubScrollViewport)

  it('lists one card per storyboard with its badges and the total', async () => {
    await renderWithProviders(<Harness />)

    const skate = await screen.findByRole('article', { name: SKATE })
    expect(within(skate).getByText('6 版')).toBeVisible()
    expect(within(skate).getByText(/4 镜/)).toBeVisible()
    // 只有一个镜头组的卡不标组数
    expect(within(skate).queryByText(/组$/)).not.toBeInTheDocument()
    const beach = screen.getByRole('article', { name: '童鞋海边亲子' })
    expect(within(beach).getByText('合成')).toBeVisible()
    expect(within(beach).getByText('4 版')).toBeVisible()
    expect(within(beach).getByText(/0:15/)).toBeVisible()
    // 两个镜头组的版本合在一张卡上
    const sandals = screen.getByRole('article', { name: SANDALS })
    expect(within(sandals).getByText('2 组')).toBeVisible()
    expect(within(sandals).getByText('3 版')).toBeVisible()
    // 没挂对话的纯文本出片没有镜数，只标时长
    const plain = screen.getByRole('article', { name: '接口提交' })
    expect(within(plain).queryByText(/镜$/)).not.toBeInTheDocument()
    expect(screen.getByText('共 6 条')).toBeVisible()
  })

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
    await user.click(screen.getByRole('radio', { name: '我出的' }))
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
    // 输入过程中不逐字请求
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

/** 等一会儿，给本不该发出的请求留出发出的时间。 */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

/** 三页、每页一张卡；`override` 给某一页换响应（挂住或报错），返回 undefined 就照常给。关键词「没有的词」什么都搜不到。 */
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
  beforeEach(stubScrollViewport)
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
    // 读完了页脚就收起，不再有读取状态
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await settle()
    expect(queries).toHaveLength(3)

    await user.type(screen.getByRole('textbox', { name: '搜索脚本' }), '没有的词')
    expect(await screen.findByText(/没有找到匹配的片子/)).toBeVisible()
  })

  it('waits for the footer to near the bottom, and starts over from the first page after a filter change', async () => {
    const queries = recordListQueries()
    serveThreePages()
    const viewport = stubIntersectionObserver()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    await screen.findAllByRole('article')
    const footer = screen.getByText('已显示 1 / 3').closest('footer')
    // 不用再点：页脚里没有按钮
    expect(footer).not.toBeNull()
    expect(within(footer as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
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
    // 第二页的卡接在已读末尾之后
    await user.keyboard('{ArrowRight}')
    expect(await screen.findByRole('dialog', { name: SKATE })).toBeVisible()
  })
})

/** 从列表点开一张卡的详情。 */
const openCard = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  const card = await screen.findByRole('article', { name: title })
  await user.click(within(card).getByRole('button', { name: `查看详情：${title}` }))
  return screen.findByRole('dialog', { name: title })
}

const playerIn = (viewer: HTMLElement, title: string) =>
  within(viewer).getByLabelText<HTMLVideoElement>(title, { selector: 'video' })

describe('library viewer', () => {
  beforeEach(() => {
    stubScrollViewport()
    // jsdom 不播放媒体，play / pause 换成立即完成。
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  it('opens a card with every version of its shot group and seeks to a cut', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, SKATE)
    const versions = await within(viewer).findByRole('group', { name: '这个镜头组的版本' })
    expect(within(versions).getAllByRole('button')).toHaveLength(6)
    expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('6')
    // 只有一个镜头组，不出组分段
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
    await user.click(await screen.findByRole('menuitem', { name: '打开来源对话' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${own?.conversationId}`))

    // 别人的卡同样带着对话 id，但读者打不开那段对话，就不给入口
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
    // 卡面在只有一版的镜头组 1 上，没有版本分段
    expect(within(groups).getByRole('button', { pressed: true })).toHaveAccessibleName('1')
    expect(
      within(viewer).queryByRole('group', { name: '这个镜头组的版本' }),
    ).not.toBeInTheDocument()

    // 点组切到那一组最新的一版
    await user.click(within(groups).getByRole('button', { name: '2' }))
    const versions = await within(viewer).findByRole('group', { name: '这个镜头组的版本' })
    expect(within(versions).getAllByRole('button')).toHaveLength(2)
    expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('2')
    expect(within(viewer).getByText('居家客厅，几何地毯与木柜；自然窗光。')).toBeVisible()

    // 点版本只换版本，组不变
    await user.click(within(versions).getByRole('button', { name: '1' }))
    expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('1')
    expect(within(groups).getByRole('button', { pressed: true })).toHaveAccessibleName('2')
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).getByText('第 1 版', { selector: 'dd' })).toBeVisible()
    // 组不是卡：还是这张卡的详情
    expect(screen.getByRole('dialog', { name: SANDALS })).toBe(viewer)

    await user.click(within(groups).getByRole('button', { name: '1' }))
    expect(
      within(viewer).queryByRole('group', { name: '这个镜头组的版本' }),
    ).not.toBeInTheDocument()
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

    // 只有一版的卡不会有这一行，也就不占
    let viewer = await openCard(user, '跑鞋手持展示')
    expect(within(viewer).queryByRole('status')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    viewer = await openCard(user, SKATE)
    expect(within(viewer).getByRole('status')).toBeInTheDocument()
    expect(
      within(viewer).queryByRole('group', { name: '这个镜头组的版本' }),
    ).not.toBeInTheDocument()

    release()
    expect(
      await within(viewer).findByRole('group', { name: '这个镜头组的版本' }),
    ).toBeInTheDocument()
    expect(within(viewer).queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows 做同款 as coming soon on focus and on click without doing anything', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithProviders(<Harness />)
    const viewer = await openCard(user, '跑鞋手持展示')
    const pathname = router.state.location.pathname
    await navigator.clipboard.writeText('原来的内容')

    const make = within(viewer).getByRole('button', { name: '做同款' })
    expect(make).toHaveAttribute('aria-disabled', 'true')
    act(() => make.focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('即将开放')
    act(() => make.blur())
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())

    await user.click(make)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('即将开放')
    expect(screen.getByRole('dialog', { name: '跑鞋手持展示' })).toBe(viewer)
    expect(router.state.location.pathname).toBe(pathname)
    await expect(navigator.clipboard.readText()).resolves.toBe('原来的内容')
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
    stubScrollViewport()
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
    // 等过悬停浮层的起延迟（150ms）：不能悬停时用鼠标点也不该再起浮层
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
