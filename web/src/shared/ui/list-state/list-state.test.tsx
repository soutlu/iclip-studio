import { useInfiniteQuery } from '@tanstack/react-query'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { renderWithProviders } from '@/testing/render'
import { ListEmpty, ListError, ListPending, LoadMoreFooter, NextPageFooter } from './list-state'

describe('列表状态块', () => {
  it('读取中是 status，失败是 alert 且重试按钮回调', async () => {
    const onRetry = vi.fn()
    await renderWithProviders(
      <>
        <ListPending label="正在读取对话" />
        <ListError message="读取失败了" onRetry={onRetry} />
        <ListEmpty>什么都没有</ListEmpty>
      </>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('正在读取对话')
    expect(screen.getByRole('alert')).toHaveTextContent('读取失败了')
    expect(screen.getByText('什么都没有')).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: '重新加载' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it.each([
    { shown: undefined, total: undefined, counter: null },
    { shown: 50, total: undefined, counter: '已显示 50' },
    { shown: 50, total: 120, counter: '已显示 50 / 120' },
  ])('页脚按给没给计数写「已显示」：$counter', async ({ shown, total, counter }) => {
    const onMore = vi.fn()
    await renderWithProviders(
      <LoadMoreFooter
        isFetching={false}
        label="显示更多"
        onMore={onMore}
        shown={shown}
        total={total}
      />,
    )

    if (counter === null) {
      expect(screen.queryByText(/已显示/)).toBeNull()
    } else {
      expect(screen.getByText(counter)).toBeVisible()
    }
    await userEvent.setup().click(screen.getByRole('button', { name: '显示更多' }))
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('读取下一页时按钮禁用并换文字', async () => {
    await renderWithProviders(<LoadMoreFooter isFetching label="显示更多" onMore={() => {}} />)

    expect(screen.getByRole('button', { name: '正在读取…' })).toBeDisabled()
  })
})

type Page = { items: string[]; nextCursor: string | null }

/** 三页、每页一行，记下每次读的游标；`override` 给某一页换结果（挂住或抛错），返回 undefined 就照常给。 */
const threePages = (override?: (cursor: string) => Promise<Page | undefined> | undefined) => {
  const cursors: (string | null)[] = []
  const fetchPage = async (cursor: string | null): Promise<Page> => {
    cursors.push(cursor)
    if (cursor === null) return { items: ['第 1 行'], nextCursor: 'p2' }
    const replaced = await override?.(cursor)
    if (replaced !== undefined) return replaced
    return cursor === 'p2'
      ? { items: ['第 2 行'], nextCursor: 'p3' }
      : { items: ['第 3 行'], nextCursor: null }
  }
  return { cursors, fetchPage }
}

/** 真的无限查询接上页脚；出错时报错与重试放在页脚上方，页脚照常挂着，看它自己会不会停。 */
function PagedList({
  fetchPage,
  counted = true,
}: {
  fetchPage: (cursor: string | null) => Promise<Page>
  counted?: boolean
}) {
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const query = useInfiniteQuery({
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page) => last.nextCursor,
    queryKey: ['paged-list'],
  })
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <main ref={mainRef}>
      <ul>
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
      {query.isError ? (
        <ListError message="读取失败" onRetry={() => void query.fetchNextPage()} />
      ) : null}
      {query.hasNextPage ? (
        <NextPageFooter
          getScrollElement={getScrollElement}
          query={query}
          {...(counted ? { shown: rows.length, total: 3 } : {})}
        />
      ) : null}
    </main>
  )
}

/** 等一会儿，给本不该发出的请求留出发出的时间。 */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

describe('自动翻页页脚', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('页脚一直在底部一屏以内就接着读，读完最后一页收起、不再多读', async () => {
    const { cursors, fetchPage } = threePages()
    stubIntersectionObserver({ inRange: true })
    await renderWithProviders(<PagedList fetchPage={fetchPage} />)

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    expect(cursors).toEqual([null, 'p2', 'p3'])
    // 读完了页脚就收起，不再有读取状态
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await settle()
    expect(cursors).toHaveLength(3)
  })

  it('页脚离底部还远时不读，滚进范围才读，页脚上写已显示几条', async () => {
    const { cursors, fetchPage } = threePages()
    const viewport = stubIntersectionObserver()
    await renderWithProviders(<PagedList fetchPage={fetchPage} />)

    expect(await screen.findByText('已显示 1 / 3')).toBeVisible()
    // 不用再点：页脚里没有按钮
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    await settle()
    expect(cursors).toEqual([null])

    await viewport.scroll(true)
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    expect(cursors).toEqual([null, 'p2', 'p3'])
  })

  it('下一页在路上时显示读取中，来回滚也只发一次；没给计数时只有读取状态', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { cursors, fetchPage } = threePages(async (cursor) => {
      if (cursor === 'p2') await held
      return undefined
    })
    const viewport = stubIntersectionObserver({ inRange: true })
    await renderWithProviders(<PagedList counted={false} fetchPage={fetchPage} />)

    await waitFor(() => expect(cursors).toEqual([null, 'p2']))
    expect(await screen.findByRole('status')).toHaveTextContent('正在读取…')
    expect(screen.queryByText(/已显示/)).not.toBeInTheDocument()
    await viewport.scroll(false)
    await viewport.scroll(true)
    await settle()
    expect(cursors).toEqual([null, 'p2'])

    release()
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    expect(cursors).toEqual([null, 'p2', 'p3'])
  })

  it('翻页出错后停下，页脚在范围内也不再读；重试成功后按当下位置接着读', async () => {
    let failing = true
    const { cursors, fetchPage } = threePages(async (cursor) => {
      if (cursor === 'p2' && failing) throw new Error('读取失败')
      return undefined
    })
    const viewport = stubIntersectionObserver({ inRange: true })
    const user = userEvent.setup()
    await renderWithProviders(<PagedList fetchPage={fetchPage} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败')
    await viewport.scroll(true)
    await settle()
    expect(cursors).toEqual([null, 'p2'])
    expect(screen.getAllByRole('listitem')).toHaveLength(1)

    failing = false
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    expect(cursors).toEqual([null, 'p2', 'p2', 'p3'])
  })
})
