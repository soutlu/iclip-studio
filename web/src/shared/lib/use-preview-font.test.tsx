import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubFontLoading } from '@/testing/font-loading'
import { server } from '@/testing/mocks/server'
import { usePreviewFont } from './use-preview-font'

const first = { id: 'font-a', url: 'https://cdn.example.test/a.otf' }
const second = { id: 'font-b', url: 'https://cdn.example.test/b.otf' }

describe('字体预览生命周期', () => {
  const clients: QueryClient[] = []
  let fonts: ReturnType<typeof stubFontLoading>

  beforeEach(() => {
    fonts = stubFontLoading()
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
    fonts.restore()
  })

  const context = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  }

  it('文件加载并注册后才可预览，卸载时移除字体', async () => {
    fonts.setMode('deferred')
    const { result, unmount } = renderHook(() => usePreviewFont(first, 'Aa'), {
      wrapper: context(),
    })
    await waitFor(() => expect(fonts.pendingCount()).toBe(1))
    expect(result.current.kind).toBe('loading')
    expect(fonts.installed.size).toBe(0)

    await act(async () => fonts.finish())
    await waitFor(() => expect(result.current.kind).toBe('ready'))
    expect(fonts.installed.size).toBe(1)
    unmount()
    expect(fonts.installed.size).toBe(0)
  })

  it('同一字体供多个预览使用，最后一个卸载才释放', async () => {
    const wrapper = context()
    const card = renderHook(() => usePreviewFont(first, 'Aa'), { wrapper })
    const dialog = renderHook(() => usePreviewFont(first, 'Other'), { wrapper })
    await waitFor(() => expect(card.result.current.kind).toBe('ready'))
    await waitFor(() => expect(dialog.result.current.kind).toBe('ready'))
    expect(fonts.installed.size).toBe(1)
    const [shared] = fonts.installed

    card.unmount()
    expect(shared !== undefined && fonts.installed.has(shared)).toBe(true)
    expect(dialog.result.current.kind).toBe('ready')
    dialog.unmount()
    expect(fonts.installed.size).toBe(0)
  })

  it('切换字体释放旧文件，卸载后完成的加载不再注册', async () => {
    const { result, rerender, unmount } = renderHook(({ font }) => usePreviewFont(font, 'Aa'), {
      initialProps: { font: first },
      wrapper: context(),
    })
    await waitFor(() => expect(result.current.kind).toBe('ready'))
    expect(fonts.installed.size).toBe(1)

    fonts.setMode('deferred')
    rerender({ font: second })
    await waitFor(() => expect(fonts.pendingCount()).toBe(1))
    expect(result.current.kind).toBe('loading')
    expect(fonts.installed.size).toBe(0)
    unmount()
    await act(async () => fonts.finish())
    expect(fonts.installed.size).toBe(0)
  })
})
