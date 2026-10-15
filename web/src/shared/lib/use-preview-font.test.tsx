import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { usePreviewFont } from './use-preview-font'

const first = { id: 'font-a', url: 'https://cdn.example.test/a.otf' }
const second = { id: 'font-b', url: 'https://cdn.example.test/b.otf' }

describe('字体预览生命周期', () => {
  const installed = new Set<unknown>()
  const loads: (() => void)[] = []
  const clients: QueryClient[] = []
  let deferred = false
  let fontSetDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    deferred = false
    loads.length = 0
    installed.clear()
    fontSetDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: installed })
    vi.stubGlobal(
      'FontFace',
      class {
        load() {
          return deferred
            ? new Promise((resolve) => loads.push(() => resolve(this)))
            : Promise.resolve(this)
        }
      },
    )
    server.use(
      http.get('*/api/brand-templates/:id/font-info', () =>
        HttpResponse.json({
          family: 'Actual Font',
          weight: 400,
          style: 'normal',
          unicodeRanges: [{ start: 32, end: 126 }],
        }),
      ),
    )
  })

  afterEach(() => {
    cleanup()
    for (const client of clients) client.clear()
    clients.length = 0
    vi.unstubAllGlobals()
    if (fontSetDescriptor === undefined) Reflect.deleteProperty(document, 'fonts')
    else Object.defineProperty(document, 'fonts', fontSetDescriptor)
  })

  const context = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  }

  it('文件加载并注册后才可预览，卸载时移除字体', async () => {
    deferred = true
    const { result, unmount } = renderHook(() => usePreviewFont(first, 'Aa'), {
      wrapper: context(),
    })
    await waitFor(() => expect(loads).toHaveLength(1))
    expect(result.current.kind).toBe('loading')
    expect(installed.size).toBe(0)

    await act(async () => loads[0]?.())
    await waitFor(() => expect(result.current.kind).toBe('ready'))
    expect(installed.size).toBe(1)
    unmount()
    expect(installed.size).toBe(0)
  })

  it('同一字体供多个预览使用，最后一个卸载才释放', async () => {
    const wrapper = context()
    const card = renderHook(() => usePreviewFont(first, 'Aa'), { wrapper })
    const dialog = renderHook(() => usePreviewFont(first, 'Other'), { wrapper })
    await waitFor(() => expect(card.result.current.kind).toBe('ready'))
    await waitFor(() => expect(dialog.result.current.kind).toBe('ready'))
    expect(installed.size).toBe(1)
    const [shared] = installed

    card.unmount()
    expect(installed.has(shared)).toBe(true)
    expect(dialog.result.current.kind).toBe('ready')
    dialog.unmount()
    expect(installed.size).toBe(0)
  })

  it('切换字体释放旧文件，卸载后完成的加载不再注册', async () => {
    const { result, rerender, unmount } = renderHook(({ font }) => usePreviewFont(font, 'Aa'), {
      initialProps: { font: first },
      wrapper: context(),
    })
    await waitFor(() => expect(result.current.kind).toBe('ready'))
    expect(installed.size).toBe(1)

    deferred = true
    rerender({ font: second })
    await waitFor(() => expect(loads).toHaveLength(1))
    expect(result.current.kind).toBe('loading')
    expect(installed.size).toBe(0)
    unmount()
    await act(async () => loads[0]?.())
    expect(installed.size).toBe(0)
  })

  it('重试替换字体实例，不把旧实例留在浏览器字体集中', async () => {
    const { result, unmount } = renderHook(() => usePreviewFont(first, '缺字'), {
      wrapper: context(),
    })
    await waitFor(() => expect(result.current.kind).toBe('failed'))
    const [previous] = installed
    expect(installed.size).toBe(1)
    const failure = result.current
    if (failure.kind !== 'failed') throw new Error('应当报告缺字')
    await act(async () => failure.retry())
    await waitFor(() => expect(installed.has(previous)).toBe(false))
    expect(installed.size).toBe(1)
    expect(result.current.kind).toBe('failed')
    unmount()
    expect(installed.size).toBe(0)
  })
})
