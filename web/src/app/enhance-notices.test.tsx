import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const USED = ['1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f']
const HD = 'https://downloads.example.test/hd.mp4'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'

type Record = Parameters<typeof makeGenerationJob>[0]

/** 一帧超分记录的状态跳转：不挂对话，信封上只有属主与 epoch。 */
const enhanceFrame = (status: string, owner = mockAuthUser.id, operation = 'enhance') => ({
  epoch: 'e1',
  owner_user_id: owner,
  payload: { id: ENHANCED, kind: 'video', operation, status },
  type: 'event.generation.changed',
})

/** 这条超分记录与它来源的各档；返回读记录与读各档的次数。 */
const serveRecord = (record: Record = {}) => {
  const reads = { enhancements: 0, record: 0 }
  server.use(
    http.get(`*/api/generations/${ENHANCED}`, () => {
      reads.record += 1
      return HttpResponse.json({
        generation: makeGenerationJob({
          id: ENHANCED,
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
      return HttpResponse.json({ downloadedJobIds: USED, tiers: [] })
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
        downloadedJobIds={USED}
        enhanceSourceId={SOURCE}
        url="https://downloads.example.test/clean.mp4"
        watermarkUrl={null}
      />
    </>,
  )
  // 属主比对要等身份读回来。
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
    { label: '整片', record: { kind: 'whole_film' as const, shotIndex: null } },
    { label: '视频', record: { shotIndex: null } },
  ])('自己的做好了：提示「$label的高清版 1080p 已生成」', async ({ label, record }) => {
    serveRecord(record)
    const { socket } = await renderNotices()

    act(() => socket.deliver(enhanceFrame('completed')))

    expect(await screen.findByText(`${label}的高清版 1080p 已生成`)).toBeVisible()
  })

  it('提示条上的「下载」：取高清原片，按来源的 downloadedJobIds 记下载事件', async () => {
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
    await waitFor(() =>
      expect(events).toEqual(USED.map((jobId) => ({ jobId, name: 'video.downloaded' }))),
    )
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
    // 留出一次请求往返，否则「没读记录」是空断言。
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

  it('断线重连后刷新各处的高清版，补上断线期间的跳转', async () => {
    const reads = serveRecord()
    const { socket } = await renderNotices()
    await waitFor(() => expect(reads.enhancements).toBe(1))

    act(() => socket.onclose?.())
    // 连接按退避（至少 1 秒）重连，换上新回调后再握手。
    await waitFor(() => expect(socket.onmessage).not.toBeNull(), { timeout: 3000 })
    act(() => socket.deliver(SERVER_HELLO))

    await waitFor(() => expect(reads.enhancements).toBe(2))
  })
})
