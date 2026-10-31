import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import type { zGenerationOut } from '@/shared/api/generated/zod.gen'
import { enhanceNoticeId } from '@/shared/api/video-enhancements'
import { Toaster, toast } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { VideoDownload } from './video-download'

const JOB_ID = '0b9c2f4e-5d8a-4c1b-9e3f-7a6d5c4b3a21'
const CLEAN = 'https://downloads.example.test/clean.mp4'
const MARKED = 'https://downloads.example.test/marked.mp4'

/** 下载边界：外链照常回字节，Blob URL 与锚点点击换成桩，点击即视为交给浏览器保存。 */
const stubSaving = () => {
  const fetched: string[] = []
  server.use(
    http.get('https://downloads.example.test/*', ({ request }) => {
      fetched.push(request.url)
      return new HttpResponse(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'video/mp4' },
      })
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
  return { fetched, saved }
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
})

afterEach(() => {
  toast.dismiss()
  vi.unstubAllGlobals()
})

describe('VideoDownload', () => {
  it.each([
    { entry: '只有原片时直接点下载', item: null, url: CLEAN, watermarkUrl: null },
    { entry: '选「下载原片」', item: '下载原片', url: CLEAN, watermarkUrl: MARKED },
    { entry: '选「下载水印版」', item: '下载水印版', url: MARKED, watermarkUrl: MARKED },
  ])(
    '$entry：按 downloadedJobIds 记下载事件，不等它回来就取字节保存',
    async ({ item, url, watermarkUrl }) => {
      const { fetched, saved } = stubSaving()
      const events: unknown[] = []
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      server.use(
        http.post('*/api/tracking/events', async ({ request }) => {
          events.push(await request.json())
          await gate
          return new HttpResponse(null, { status: 204 })
        }),
      )
      const user = userEvent.setup()
      await renderWithProviders(
        <VideoDownload downloadedJobIds={[JOB_ID]} url={CLEAN} watermarkUrl={watermarkUrl} />,
      )

      await user.click(screen.getByRole('button', { name: '下载视频' }))
      if (item !== null) await user.click(await screen.findByRole('menuitem', { name: item }))

      await waitFor(() => expect(events).toEqual([{ jobId: JOB_ID, name: 'video.downloaded' }]))
      // 事件还悬着，字节已经取回并交给浏览器。
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
      expect(fetched).toEqual([url])
      release()
    },
  )

  it.each(['http', 'network', 'empty'])(
    '下载遇到 %s 错误时提示失败并允许重试，等待时阻止重复点击',
    async (failure) => {
      let requests = 0
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const url = 'https://downloads.example.test/result.webm'
      server.use(
        http.get(url, async () => {
          requests += 1
          await gate
          if (failure === 'network') return HttpResponse.error()
          if (failure === 'http') return new HttpResponse('下载服务不可用', { status: 503 })
          return new HttpResponse(null, { status: 200 })
        }),
        http.post('*/api/tracking/events', () => new HttpResponse(null, { status: 204 })),
      )
      const createObjectURL = vi.fn(() => 'blob:http://localhost/download')
      // 补齐下载边界，避免 jsdom 缺少 Blob URL API 掩盖状态码校验失效。
      vi.stubGlobal(
        'URL',
        class extends URL {
          static override createObjectURL = createObjectURL
          static override revokeObjectURL() {}
        },
      )
      const anchorClick = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {})
      await renderWithProviders(
        <>
          <Toaster />
          <VideoDownload downloadedJobIds={[JOB_ID]} url={url} watermarkUrl={null} />
        </>,
      )
      await userEvent.click(screen.getByRole('button', { name: '下载视频' }))
      const busy = screen.getByRole('button', { name: '正在准备下载…' })
      expect(busy).toHaveAttribute('aria-disabled', 'true')
      await userEvent.click(busy)
      await waitFor(() => expect(requests).toBe(1))
      release()
      expect(await screen.findByText('视频下载失败，请重试')).toBeVisible()
      expect(screen.getByRole('button', { name: '下载视频' })).not.toHaveAttribute('aria-disabled')
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(anchorClick).not.toHaveBeenCalled()
      await userEvent.click(screen.getByRole('button', { name: '下载视频' }))
      await waitFor(() => expect(requests).toBe(2))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '下载视频' })).not.toHaveAttribute(
          'aria-disabled',
        ),
      )
    },
  )

  it('带字按钮：名字就是那段字；每下载一次，给的每条记录各记一条，连点也照记；没给记录就不记', async () => {
    const { fetched, saved } = stubSaving()
    const events: unknown[] = []
    server.use(
      http.post('*/api/tracking/events', async ({ request }) => {
        events.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
    const user = userEvent.setup()
    const { rerender } = await renderWithProviders(
      <VideoDownload downloadedJobIds={[JOB_ID, OTHER]} url={CLEAN} watermarkUrl={null}>
        下载成片
      </VideoDownload>,
    )

    const button = screen.getByRole('button', { name: '下载成片' })
    await user.click(button)
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(events).toHaveLength(4))
    expect(events).toEqual(
      [JOB_ID, OTHER, JOB_ID, OTHER].map((jobId) => ({ jobId, name: 'video.downloaded' })),
    )

    rerender(
      <VideoDownload downloadedJobIds={[]} url={CLEAN} watermarkUrl={null}>
        下载成片
      </VideoDownload>,
    )
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(3))
    expect(fetched).toEqual([CLEAN, CLEAN, CLEAN])
    expect(events).toHaveLength(4)
  })

  it('事件接口失败时下载照常完成，不弹提示，只在控制台留一条警告', async () => {
    const { fetched, saved } = stubSaving()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(
      http.post('*/api/tracking/events', () =>
        HttpResponse.json({ detail: '埋点暂时不可用' }, { status: 500 }),
      ),
    )
    await renderWithProviders(
      <>
        <Toaster />
        <VideoDownload downloadedJobIds={[JOB_ID]} url={CLEAN} watermarkUrl={null} />
      </>,
    )

    await userEvent.click(screen.getByRole('button', { name: '下载视频' }))

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    expect(fetched).toEqual([CLEAN])
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '下载视频' })).not.toHaveAttribute('aria-disabled'),
    )
    const notifications = screen.getByRole('region', { name: /Notifications/ })
    expect(within(notifications).queryAllByRole('listitem')).toHaveLength(0)
  })
})

describe('VideoDownload · 高清版', () => {
  const HD = 'https://downloads.example.test/hd-1080.mp4'
  const ENHANCEMENTS_URL = `*/api/generations/${JOB_ID}/enhancements`

  type GenerationJob = z.output<typeof zGenerationOut>
  /** `mine` 缺省为 true：记录是自己的。 */
  type Tier = { resolution: '1080p' | '720p'; job: GenerationJob | null; mine?: boolean }

  const enhanceJob = (status: GenerationJob['status'], overrides: Partial<GenerationJob> = {}) =>
    makeGenerationJob({
      createdAt: new Date(Date.now() - 42_000).toISOString(),
      operation: 'enhance',
      sourceJobId: JOB_ID,
      status,
      ...overrides,
    })

  /** 各档按给的样子答，`answer(...)` 换成另一种答法；`reads` 是读了几次。 */
  const serveTiers = (tiers: Tier[]) => {
    const state = {
      answer: (next: Tier[]) => {
        current = next
      },
      reads: 0,
    }
    let current = tiers
    server.use(
      http.get(ENHANCEMENTS_URL, () => {
        state.reads += 1
        return HttpResponse.json({
          downloadedJobIds: [JOB_ID],
          tiers: current.map((tier) => ({ ...tier, mine: tier.mine ?? true })),
        })
      }),
    )
    return state
  }

  const ring = (button: HTMLElement) => button.querySelector('[data-enhance-ring]')
  const dot = (button: HTMLElement) => button.querySelector('[data-enhance-dot]')

  /** 提交收下的请求体；`release` 之前悬着，答复是一条刚受理的超分记录。 */
  const holdSubmits = () => {
    const bodies: unknown[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/generations/video-enhancements', async ({ request }) => {
        const body = (await request.json()) as { resolution: string }
        bodies.push(body)
        await gate
        return HttpResponse.json(
          {
            generation: enhanceJob('pending', {
              createdAt: new Date().toISOString(),
              request: { resolution: body.resolution },
            }),
          },
          { status: 202 },
        )
      }),
    )
    return { bodies, release: () => release() }
  }

  const renderEnhanceable = async (props: Partial<Parameters<typeof VideoDownload>[0]> = {}) => {
    const user = userEvent.setup()
    const rendered = await renderWithProviders(
      <>
        <Toaster />
        <VideoDownload
          downloadedJobIds={[JOB_ID]}
          durationMs={6000}
          enhanceSourceId={JOB_ID}
          url={CLEAN}
          watermarkUrl={MARKED}
          {...props}
        />
      </>,
    )
    // 等各档读回来再点，免得点在「还没有档」的那一刻。
    await waitFor(() =>
      expect(rendered.queryClient.getQueryData(['video-enhancements', JOB_ID])).toBeDefined(),
    )
    return { ...rendered, user }
  }

  const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: '下载视频' }))
    return screen.findByRole('menu')
  }

  const itemNames = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)

  it('没做与在做：原片、水印版之后按档从高到低列；没做的带预计时间，在做的转圈计时、点不了', async () => {
    serveTiers([
      { job: null, resolution: '1080p' },
      { job: enhanceJob('submitted'), resolution: '720p' },
    ])
    const { user } = await renderEnhanceable()
    const menu = await openMenu(user)

    expect(itemNames(menu)).toEqual([
      '下载原片',
      '下载水印版',
      '生成高清版 1080p约 2 分钟',
      expect.stringMatching(/^正在生成高清版 720p0:4\d$/),
    ])
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /^正在生成高清版 720p/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(menu).getByRole('menuitem', { name: /^生成高清版 1080p/ })).not.toHaveAttribute(
      'aria-disabled',
    )
  })

  it('不知道片长时不估时间', async () => {
    serveTiers([{ job: null, resolution: '1080p' }])
    const { user } = await renderEnhanceable({ durationMs: null })
    const menu = await openMenu(user)
    expect(within(menu).getByRole('menuitem', { name: /^生成高清版 1080p/ })).toHaveTextContent(
      /^生成高清版 1080p$/,
    )
  })

  it('做好与没做成：做好的可以下载，没做成的提示重试', async () => {
    serveTiers([
      { job: enhanceJob('completed', { outputUrl: HD }), resolution: '1080p' },
      { job: enhanceJob('failed'), resolution: '720p' },
    ])
    const { user } = await renderEnhanceable()
    const menu = await openMenu(user)
    expect(itemNames(menu)).toEqual([
      '下载原片',
      '下载水印版',
      '下载高清版 1080p',
      '高清版 720p 生成失败，请重试',
    ])
  })

  it('点「生成高清版」：菜单不关，请求还在路上时那一行就变成在做，提交的是这条来源这一档', async () => {
    const tiers = serveTiers([{ job: null, resolution: '1080p' }])
    const submits = holdSubmits()
    const { user } = await renderEnhanceable()
    // 菜单开着时它外面的内容对读屏隐藏，按钮先拿到手。
    const trigger = screen.getByRole('button', { name: '下载视频' })
    expect(trigger).not.toHaveAccessibleDescription()
    const menu = await openMenu(user)
    // 打开时重拉的那一次落定后再点，免得它把在路上的那一行盖回去。
    await waitFor(() => expect(tiers.reads).toBe(2))
    tiers.answer([{ job: enhanceJob('pending'), resolution: '1080p' }])

    await user.click(within(menu).getByRole('menuitem', { name: /^生成高清版 1080p/ }))

    expect(screen.getByRole('menu')).toBe(menu)
    const running = await within(menu).findByRole('menuitem', { name: /^正在生成高清版 1080p/ })
    expect(running).toHaveAttribute('aria-disabled', 'true')
    await waitFor(() =>
      expect(submits.bodies).toEqual([{ resolution: '1080p', sourceJobId: JOB_ID }]),
    )
    // 在路上时再点也点不了，不会提交第二次。
    await user.click(running)
    expect(submits.bodies).toHaveLength(1)

    submits.release()
    await waitFor(() => expect(tiers.reads).toBe(3))
    expect(within(menu).getByRole('menuitem', { name: /^正在生成高清版 1080p/ })).toBeVisible()
    expect(trigger).toHaveAccessibleDescription('高清版正在生成')
    expect(ring(trigger)).not.toBeNull()
  })

  it('点没做成的那一行重试：菜单不关，那一行变成在做，按钮上的红点换成外圈转圈', async () => {
    const tiers = serveTiers([{ job: enhanceJob('failed'), resolution: '1080p' }])
    const submits = holdSubmits()
    const { user } = await renderEnhanceable()
    // 菜单开着时它外面的内容对读屏隐藏，按钮先拿到手。
    const trigger = screen.getByRole('button', { name: '下载视频' })
    expect(trigger).toHaveAccessibleDescription('高清版生成失败')
    const menu = await openMenu(user)
    await waitFor(() => expect(tiers.reads).toBe(2))
    tiers.answer([{ job: enhanceJob('pending'), resolution: '1080p' }])

    await user.click(within(menu).getByRole('menuitem', { name: '高清版 1080p 生成失败，请重试' }))

    expect(screen.getByRole('menu')).toBe(menu)
    expect(
      await within(menu).findByRole('menuitem', { name: /^正在生成高清版 1080p/ }),
    ).toBeVisible()
    expect(trigger).toHaveAccessibleDescription('高清版正在生成')
    expect(ring(trigger)).not.toBeNull()
    expect(dot(trigger)).toBeNull()
    submits.release()
    await waitFor(() =>
      expect(submits.bodies).toEqual([{ resolution: '1080p', sourceJobId: JOB_ID }]),
    )
  })

  it('下载高清版：取高清原片，按 downloadedJobIds 记下载事件，并收起这一档的提示条', async () => {
    serveTiers([{ job: enhanceJob('completed', { outputUrl: HD }), resolution: '1080p' }])
    const { fetched, saved } = stubSaving()
    const events: unknown[] = []
    server.use(
      http.post('*/api/tracking/events', async ({ request }) => {
        events.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
    const { user } = await renderEnhanceable({ downloadedJobIds: [JOB_ID, OTHER] })
    act(() => {
      toast('第 2 组的高清版 1080p 已生成', { id: enhanceNoticeId(JOB_ID, '1080p') })
    })
    expect(await screen.findByText('第 2 组的高清版 1080p 已生成')).toBeVisible()
    expect(screen.getByRole('button', { name: '下载视频' })).toHaveAccessibleDescription(
      '高清版已生成',
    )

    const menu = await openMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: '下载高清版 1080p' }))

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    expect(fetched).toEqual([HD])
    await waitFor(() =>
      expect(events).toEqual([JOB_ID, OTHER].map((jobId) => ({ jobId, name: 'video.downloaded' }))),
    )
    await waitFor(() =>
      expect(screen.queryByText('第 2 组的高清版 1080p 已生成')).not.toBeInTheDocument(),
    )
  })

  it('只有原片：有能做的档就先开菜单，第一项用调用方给的名字', async () => {
    serveTiers([{ job: null, resolution: '1080p' }])
    const { user } = await renderEnhanceable({ originalLabel: '下载成片', watermarkUrl: null })
    const menu = await openMenu(user)
    expect(itemNames(menu)).toEqual(['下载成片', '生成高清版 1080p约 2 分钟'])
  })

  it('只有原片且没有能做的档：点了直接下载', async () => {
    serveTiers([])
    const { fetched, saved } = stubSaving()
    const { user } = await renderEnhanceable({ watermarkUrl: null })

    await user.click(screen.getByRole('button', { name: '下载视频' }))

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    expect(fetched).toEqual([CLEAN])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载视频' })).not.toHaveAccessibleDescription()
  })

  it('带字按钮：有一档在做或有没看过的结果，按钮上都不标', async () => {
    serveTiers([
      { job: enhanceJob('submitted'), resolution: '1080p' },
      { job: enhanceJob('failed'), resolution: '720p' },
    ])
    await renderEnhanceable({ children: '下载成片' })
    const button = screen.getByRole('button', { name: '下载成片' })
    expect(button).not.toHaveAccessibleDescription()
    expect(ring(button)).toBeNull()
    expect(dot(button)).toBeNull()
  })

  it('有一档在做（别人的也算）：按钮外圈转一段细弧，不出点', async () => {
    serveTiers([
      { job: enhanceJob('submitted'), mine: false, resolution: '1080p' },
      { job: enhanceJob('failed'), resolution: '720p' },
    ])
    await renderEnhanceable()
    const button = screen.getByRole('button', { name: '下载视频' })

    expect(button).toHaveAccessibleDescription('高清版正在生成')
    expect(ring(button)).not.toBeNull()
    expect(dot(button)).toBeNull()
  })

  it.each([
    { description: '高清版已生成', state: 'done', status: 'completed' },
    { description: '高清版生成失败', state: 'failed', status: 'failed' },
  ] as const)(
    '自己的 $status：提示生成结果，没有进行中的外圈',
    async ({ description, state, status }) => {
      serveTiers([
        {
          job: enhanceJob(status, { outputUrl: status === 'completed' ? HD : null }),
          resolution: '1080p',
        },
      ])
      await renderEnhanceable()
      const button = screen.getByRole('button', { name: '下载视频' })

      expect(button).toHaveAccessibleDescription(description)
      expect(dot(button)).toHaveAttribute('data-enhance-dot', state)
      expect(ring(button)).toBeNull()
    },
  )

  it('别人的做好、没做成：不出点，菜单里照样能下载', async () => {
    serveTiers([
      { job: enhanceJob('completed', { outputUrl: HD }), mine: false, resolution: '1080p' },
      { job: enhanceJob('failed'), mine: false, resolution: '720p' },
    ])
    const { user } = await renderEnhanceable()
    const button = screen.getByRole('button', { name: '下载视频' })

    expect(button).not.toHaveAccessibleDescription()
    expect(dot(button)).toBeNull()
    expect(ring(button)).toBeNull()
    const menu = await openMenu(user)
    expect(within(menu).getByRole('menuitem', { name: '下载高清版 1080p' })).toBeVisible()
  })

  it('打开菜单就算看过：点消失，重新挂载后也不回来；打开时重拉各档', async () => {
    const job = enhanceJob('completed', { outputUrl: HD })
    const tiers = serveTiers([{ job, resolution: '1080p' }])
    const { unmount, user } = await renderEnhanceable()
    expect(screen.getByRole('button', { name: '下载视频' })).toHaveAccessibleDescription(
      '高清版已生成',
    )
    expect(tiers.reads).toBe(1)

    await openMenu(user)
    await waitFor(() => expect(tiers.reads).toBe(2))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    const button = screen.getByRole('button', { name: '下载视频' })
    expect(button).not.toHaveAccessibleDescription()
    expect(dot(button)).toBeNull()
    unmount()
    await renderEnhanceable()
    const remounted = screen.getByRole('button', { name: '下载视频' })
    expect(remounted).not.toHaveAccessibleDescription()
    expect(dot(remounted)).toBeNull()
  })

  it('打开菜单时重拉：别人刚提交的那一档转起来，菜单里那一行变成在做', async () => {
    const tiers = serveTiers([{ job: null, resolution: '1080p' }])
    const { user } = await renderEnhanceable()
    const button = screen.getByRole('button', { name: '下载视频' })
    expect(ring(button)).toBeNull()
    tiers.answer([{ job: enhanceJob('submitted'), mine: false, resolution: '1080p' }])

    const menu = await openMenu(user)

    expect(
      await within(menu).findByRole('menuitem', { name: /^正在生成高清版 1080p/ }),
    ).toBeVisible()
    expect(tiers.reads).toBe(2)
    expect(ring(button)).not.toBeNull()
  })

  it('菜单开着时出了结果：那一行原地变成下载，关上菜单也不出点', async () => {
    const tiers = serveTiers([{ job: enhanceJob('submitted'), resolution: '1080p' }])
    const { queryClient, user } = await renderEnhanceable()
    const menu = await openMenu(user)
    await waitFor(() => expect(tiers.reads).toBe(2))

    tiers.answer([{ job: enhanceJob('completed', { outputUrl: HD }), resolution: '1080p' }])
    // 状态跳转帧到了：app 层失效这条来源的查询。
    await act(() => queryClient.invalidateQueries({ queryKey: ['video-enhancements', JOB_ID] }))
    expect(await within(menu).findByRole('menuitem', { name: '下载高清版 1080p' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    const button = screen.getByRole('button', { name: '下载视频' })
    expect(button).not.toHaveAccessibleDescription()
    expect(dot(button)).toBeNull()
  })

  it('不给 enhanceSourceId：不读高清版，菜单只有原片与水印版', async () => {
    let reads = 0
    server.use(
      http.get('*/api/generations/:jobId/enhancements', () => {
        reads += 1
        return HttpResponse.json({ downloadedJobIds: [], tiers: [] })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(
      <VideoDownload downloadedJobIds={[JOB_ID]} url={CLEAN} watermarkUrl={MARKED} />,
    )
    const menu = await openMenu(user)
    expect(itemNames(menu)).toEqual(['下载原片', '下载水印版'])
    expect(within(menu).queryByRole('separator')).not.toBeInTheDocument()
    expect(reads).toBe(0)
  })
})
