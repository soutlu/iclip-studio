import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_WHOLE_FILM_SCOPE, type WholeFilmCard } from '../whole-films.api'
import { WholeFilmsRoute } from './whole-films-route'

const version = (n: number) => ({
  jobId: `fa010001-0000-4000-8000-${String(n).padStart(12, '0')}`,
  outputUrl: `https://media.test/film-${n}.mp4`,
  watermarkOutputUrl: null,
  durationMs: n * 1000,
  finishedAt: `2026-10-14T10:00:0${n}Z`,
  userName: 'writer',
})
const film: WholeFilmCard = {
  conversationId: 'fa010002-0000-4000-8000-000000000001',
  title: '秋日整片',
  canOpenConversation: true,
  userName: 'tester',
  face: version(2),
  versions: [version(1), version(2)],
}

function Harness({ initialFilm = null }: { initialFilm?: string | null }) {
  const [scope, setScope] = useState(DEFAULT_WHOLE_FILM_SCOPE)
  const [filmId, setFilmId] = useState(initialFilm)
  return (
    <WholeFilmsRoute
      tabs={null}
      myUserName="tester"
      filmId={filmId}
      onFilmChange={setFilmId}
      scope={scope}
      onScopeChange={(next) => {
        setScope(next)
        setFilmId(null)
      }}
    />
  )
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.tagName === 'MAIN' ? 900 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.tagName === 'MAIN' ? 1200 : 0
  })
  server.use(
    http.get('*/api/library/whole-films', () =>
      HttpResponse.json({ items: [film], nextCursor: null, total: 1 }),
    ),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WholeFilmsRoute', () => {
  it('按最新一版展示卡片，切换版本后下载与埋点使用同一条记录，没有脚本或做同款', async () => {
    const events: unknown[] = []
    server.use(
      http.post('*/api/tracking/events', async ({ request }) => {
        events.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(
        'https://media.test/film-1.mp4',
        () => new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } }),
      ),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: '秋日整片' })
    expect(within(card).getByText('V2')).toBeVisible()
    await user.click(within(card).getByRole('button', { name: '查看整片：秋日整片' }))
    const dialog = screen.getByRole('dialog', { name: '秋日整片' })
    expect(within(dialog).getByRole('button', { name: 'V2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(dialog).queryByText('脚本')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '做同款' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: '打开来源任务' })).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'V1' }))
    await user.click(within(dialog).getByRole('button', { name: '下载视频' }))
    await waitFor(() =>
      expect(events).toEqual([{ jobId: version(1).jobId, name: 'video.downloaded' }]),
    )
  })

  it('不能打开来源的读者仍可预览各版，但没有来源任务入口', async () => {
    server.use(
      http.get('*/api/library/whole-films', () =>
        HttpResponse.json({
          items: [{ ...film, canOpenConversation: false }],
          nextCursor: null,
          total: 1,
        }),
      ),
    )
    await renderWithProviders(<Harness initialFilm={film.conversationId} />)
    const dialog = await screen.findByRole('dialog', { name: '秋日整片' })
    expect(within(dialog).queryByRole('button', { name: '打开来源任务' })).toBeNull()
    expect(within(dialog).getByRole('group', { name: '整片版本' })).toBeVisible()
  })

  it('按标题与作者筛选，不向端点发送画幅', async () => {
    const queries: URLSearchParams[] = []
    server.use(
      http.get('*/api/library/whole-films', ({ request }) => {
        queries.push(new URL(request.url).searchParams)
        return HttpResponse.json({ items: [film], nextCursor: null, total: 1 })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article')
    expect(screen.queryByRole('radiogroup', { name: '画幅' })).toBeNull()
    await user.click(screen.getByRole('radio', { name: '我生成的' }))
    await user.type(screen.getByRole('textbox', { name: '搜索整片标题' }), '秋日')
    await waitFor(() => expect(queries.at(-1)?.get('q')).toBe('秋日'))
    expect(queries.at(-1)?.get('userName')).toBe('tester')
    expect(queries.every((query) => !query.has('orientation'))).toBe(true)
  })

  it('作者不在已加载卡片或成片作者候选中时，可以直接按用户名筛选', async () => {
    const queries: URLSearchParams[] = []
    server.use(
      http.get('*/api/library/whole-films', ({ request }) => {
        const query = new URL(request.url).searchParams
        queries.push(query)
        return HttpResponse.json({
          items:
            query.get('userName') === 'OnlyFilm.Owner'
              ? [{ ...film, title: '未加载作者的整片', userName: 'OnlyFilm.Owner' }]
              : [film],
          nextCursor: null,
          total: 1,
        })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article')
    await user.click(screen.getByRole('button', { name: '人：人' }))
    await user.type(screen.getByRole('combobox', { name: '搜索人' }), 'OnlyFilm.Owner')
    await user.click(screen.getByRole('button', { name: '按用户名筛选：OnlyFilm.Owner' }))
    expect(await screen.findByRole('article', { name: '未加载作者的整片' })).toBeVisible()
    expect(queries.at(-1)?.get('userName')).toBe('OnlyFilm.Owner')
  })

  it('地址直达未加载的卡时继续翻页，第二页出错保留列表并可重试', async () => {
    stubIntersectionObserver()
    let failed = true
    const second = {
      ...film,
      conversationId: 'fa010002-0000-4000-8000-000000000002',
      title: '第二条整片',
    }
    server.use(
      http.get('*/api/library/whole-films', ({ request }) => {
        if (!new URL(request.url).searchParams.has('cursor'))
          return HttpResponse.json({ items: [film], nextCursor: 'next', total: 2 })
        if (failed) return HttpResponse.json({ detail: '下一页暂不可用' }, { status: 503 })
        return HttpResponse.json({ items: [second], nextCursor: null, total: null })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness initialFilm={second.conversationId} />)
    const dialog = await screen.findByRole('dialog', { name: '整片详情' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('下一页暂不可用')
    failed = false
    await user.click(within(dialog).getByRole('button', { name: '重新加载' }))
    expect(await screen.findByRole('dialog', { name: '第二条整片' })).toBeVisible()
  })

  it('不合法的响应显示读取错误，而不是空成功列表', async () => {
    server.use(
      http.get('*/api/library/whole-films', () =>
        HttpResponse.json({ items: [{ title: '缺失版本' }], nextCursor: null, total: 1 }),
      ),
    )
    await renderWithProviders(<Harness />)
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible()
  })
})
