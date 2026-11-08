import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSeenEnhancements } from '@/shared/api/video-enhancements-seen'
import { Toaster, toast } from '@/shared/ui/toast'
import { VideoDownload } from '@/shared/ui/video-download'
import { makeGenerationJob } from '@/testing/generation-job'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { SERVER_HELLO } from '@/testing/ws'
import { EnhanceNotices } from './enhance-notices'

const SOURCE = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const ENHANCED = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const HD = 'https://downloads.example.test/hd.mp4'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'

type Record = Parameters<typeof makeGenerationJob>[0]

const enhanceFrame = (
  status: string,
  owner = mockAuthUser.id,
  operation = 'enhance',
  id = ENHANCED,
) => ({
  owner_user_id: owner,
  payload: { id, kind: 'video', operation, status },
  timestamp: '2026-10-30T08:00:00+00:00',
  type: 'event.generation.changed',
})

const serveRecord = (record: Record = {}) => {
  const reads = { enhancements: 0, record: 0 }
  const id = record.id ?? ENHANCED
  server.use(
    http.get(`*/api/generations/${id}`, () => {
      reads.record += 1
      return HttpResponse.json({
        generation: makeGenerationJob({
          id,
          operation: 'enhance',
          outputUrl: HD,
          request: { resolution: '1080p' },
          shotIndex: 2,
          sourceJobId: SOURCE,
          status: 'completed',
          ...record,
        }),
      })
    }),
    http.get(`*/api/generations/${SOURCE}/enhancements`, () => {
      reads.enhancements += 1
      return HttpResponse.json({ tiers: [] })
    }),
  )
  return reads
}

const renderNotices = async () => {
  const rendered = await renderWithProviders(
    <>
      <Toaster />
      <EnhanceNotices />
      <VideoDownload
        enhanceSourceId={SOURCE}
        jobId={SOURCE}
        url="https://downloads.example.test/clean.mp4"
        watermarkUrl={null}
      />
    </>,
  )
  await waitFor(() =>
    expect(rendered.queryClient.getQueryData(['auth', 'current-user'])).toBeTruthy(),
  )
  return rendered
}

beforeEach(() => {
  loginAs(mockAuthUser)
})

afterEach(() => {
  act(() => {
    toast.dismiss()
  })
  vi.unstubAllGlobals()
})

describe('EnhanceNotices', () => {
  it.each([
    { label: '第 2 组', record: { shotIndex: 2 } },
    { label: '视频', record: { shotIndex: null } },
  ])('自己的做好了：提示「$label的高清版 1080p 已生成」', async ({ label, record }) => {
    serveRecord(record)
    const { socket } = await renderNotices()

    act(() => socket.deliver(enhanceFrame('completed')))

    expect(await screen.findByText(`${label}的高清版 1080p 已生成`)).toBeVisible()
  })

  it('提示条上的「下载」：取高清原片，保存成功后记这条高清版', async () => {
    serveRecord()
    const events: unknown[] = []
    const fetched: string[] = []
    server.use(
      http.post('*/api/tracking/events', async ({ request }) => {
        events.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(HD, ({ request }) => {
        fetched.push(request.url)
        return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } })
      }),
    )
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = () => 'blob:http://localhost/video'
        static override revokeObjectURL() {}
      },
    )
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { socket } = await renderNotices()

    act(() => socket.deliver(enhanceFrame('completed')))
    await userEvent.click(await screen.findByRole('button', { name: '下载' }))

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    expect(fetched).toEqual([HD])
    await waitFor(() => expect(events).toEqual([{ jobId: ENHANCED, name: 'video.downloaded' }]))
  })

  it('提示条上的「下载」取不到文件：提示失败，不记事件', async () => {
    serveRecord()
    let events = 0
    server.use(
      http.post('*/api/tracking/events', () => {
        events += 1
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(HD, () => new HttpResponse('下载服务不可用', { status: 503 })),
    )
    const { socket } = await renderNotices()

    act(() => socket.deliver(enhanceFrame('completed')))
    await userEvent.click(await screen.findByRole('button', { name: '下载' }))

    expect(await screen.findByText('视频下载失败，请重试')).toBeVisible()
    expect(events).toBe(0)
  })

  it('自己的没做成：提示失败，「重试」按这条来源这一档重新提交', async () => {
    serveRecord({ outputUrl: null, status: 'failed' })
    const bodies: unknown[] = []
    server.use(
      http.post('*/api/generations/video-enhancements', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json(
          {
            generation: makeGenerationJob({
              operation: 'enhance',
              sourceJobId: SOURCE,
              status: 'pending',
            }),
          },
          { status: 202 },
        )
      }),
    )
    const { socket } = await renderNotices()

    act(() => socket.deliver(enhanceFrame('failed')))
    expect(await screen.findByText('第 2 组的高清版 1080p 生成失败，请重试')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(bodies).toEqual([{ resolution: '1080p', sourceJobId: SOURCE }]))
    await waitFor(() =>
      expect(screen.queryByText('第 2 组的高清版 1080p 生成失败，请重试')).not.toBeInTheDocument(),
    )
  })

  it('别人的帧（治理者也收得到）只刷新，不读记录、不弹提示', async () => {
    const reads = serveRecord()
    const { socket } = await renderNotices()
    await waitFor(() => expect(reads.enhancements).toBe(1))

    act(() => socket.deliver(enhanceFrame('completed', OTHER_USER)))

    await waitFor(() => expect(reads.enhancements).toBe(2))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(reads.record).toBe(0)
    expect(screen.queryByText(/高清版/)).not.toBeInTheDocument()
  })

  it('在做的帧只刷新各处的高清版，不弹提示；不是超分的帧不刷新', async () => {
    const reads = serveRecord()
    const { socket } = await renderNotices()
    await waitFor(() => expect(reads.enhancements).toBe(1))

    act(() => socket.deliver(enhanceFrame('submitted')))
    await waitFor(() => expect(reads.enhancements).toBe(2))

    act(() => socket.deliver(enhanceFrame('completed', mockAuthUser.id, 'generate')))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(reads.enhancements).toBe(2)
    expect(reads.record).toBe(0)
    expect(screen.queryByText(/高清版/)).not.toBeInTheDocument()
  })

  describe('看过', () => {
    const freshRecord = (record: Record = {}) => {
      const id = crypto.randomUUID()
      serveRecord({ id, ...record })
      server.use(
        http.post('*/api/tracking/events', () => new HttpResponse(null, { status: 204 })),
        http.get(HD, () => new HttpResponse(new Uint8Array([1]))),
        http.post('*/api/generations/video-enhancements', () =>
          HttpResponse.json(
            { generation: makeGenerationJob({ operation: 'enhance', sourceJobId: SOURCE }) },
            { status: 202 },
          ),
        ),
      )
      vi.stubGlobal(
        'URL',
        class extends URL {
          static override createObjectURL = () => 'blob:http://localhost/video'
          static override revokeObjectURL() {}
        },
      )
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      return id
    }

    const watchSeen = () => renderHook(() => useSeenEnhancements()).result

    afterEach(() => {
      vi.useRealTimers()
    })

    it.each([
      { action: '下载', record: {}, status: 'completed', text: '第 2 组的高清版 1080p 已生成' },
      {
        action: '重试',
        record: { outputUrl: null, status: 'failed' as const },
        status: 'failed',
        text: '第 2 组的高清版 1080p 生成失败，请重试',
      },
    ])('点提示条上的「$action」：这条记录算看过', async ({ action, record, status, text }) => {
      const id = freshRecord(record)
      const seen = watchSeen()
      const { socket } = await renderNotices()

      act(() => socket.deliver(enhanceFrame(status, mockAuthUser.id, 'enhance', id)))
      expect(await screen.findByText(text)).toBeVisible()
      expect(seen.current.has(id)).toBe(false)
      await userEvent.click(screen.getByRole('button', { name: action }))

      await waitFor(() => expect(seen.current.has(id)).toBe(true))
    })

    it('手动划走提示条：这条记录算看过', async () => {
      const id = freshRecord()
      const seen = watchSeen()
      const { socket } = await renderNotices()
      act(() => socket.deliver(enhanceFrame('completed', mockAuthUser.id, 'enhance', id)))
      const notice = (await screen.findByText('第 2 组的高清版 1080p 已生成')).closest('li')
      if (notice === null) throw new Error('提示条不在列表里')

      fireEvent.pointerDown(notice, { clientX: 0, clientY: 0, pointerId: 1 })
      fireEvent.pointerMove(notice, { clientX: 0, clientY: 5, pointerId: 1 })
      fireEvent.pointerMove(notice, { clientX: 0, clientY: 120, pointerId: 1 })
      fireEvent.pointerUp(notice, { clientX: 0, clientY: 120, pointerId: 1 })

      await waitFor(() => expect(seen.current.has(id)).toBe(true))
    })

    it('8 秒自己收起：不算看过', async () => {
      const id = freshRecord()
      const seen = watchSeen()
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { socket } = await renderNotices()
      act(() => socket.deliver(enhanceFrame('completed', mockAuthUser.id, 'enhance', id)))
      expect(await screen.findByText('第 2 组的高清版 1080p 已生成')).toBeVisible()

      act(() => {
        vi.advanceTimersByTime(8_000)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      await waitFor(() =>
        expect(screen.queryByText('第 2 组的高清版 1080p 已生成')).not.toBeInTheDocument(),
      )
      expect(seen.current.has(id)).toBe(false)
    })
  })

  it('断线重连后刷新各处的高清版，补上断线期间的跳转', async () => {
    const reads = serveRecord()
    const { socket } = await renderNotices()
    await waitFor(() => expect(reads.enhancements).toBe(1))

    act(() => socket.onclose?.())
    await waitFor(() => expect(socket.onmessage).not.toBeNull(), { timeout: 3000 })
    act(() => socket.deliver(SERVER_HELLO))

    await waitFor(() => expect(reads.enhancements).toBe(2))
  })
})
