import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { renderWithProviders } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import { TakesTray } from './takes-tray'

const HISTORY_SHOT = {
  global_settings: '历史版参考锁定。',
  timeline: [{ image_indexes: [1], prompt: '历史版：走向镜头 @Image1。', timestamps: [0, 4] }],
}

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob =>
  makeGenerationJob({ createdAt: '2026-09-01T10:00:00Z', shotIndex: 2, ...spec })

const completed = job({
  createdAt: '2026-09-01T10:04:00Z',
  durationMs: 11_000,
  id: 'completed',
  outputUrl: 'https://assets.oss-ap-southeast-1.aliyuncs.com/take.mp4',
  request: {
    model: 'vendor-a-seedance-2-5',
    prompt: '拼好的正文',
    resolution: '720p',
    shot: HISTORY_SHOT,
  },
})
const failed = job({
  createdAt: '2026-09-01T11:40:00Z',
  errorMessage: '上游返回了空结果。',
  id: 'failed',
  request: { resolution: '1080p' },
  status: 'failed',
})
const running = job({ createdAt: '2026-09-01T12:20:00Z', id: 'running', status: 'pending' })

const renderTray = async (
  jobs: GenerationJob[] | undefined,
  overrides: Partial<Parameters<typeof TakesTray>[0]> = {},
) => {
  const props = {
    aspectRatio: '9:16',
    error: undefined,
    jobs,
    onEditVideo: vi.fn(),
    onPreview: vi.fn(),
    onRefill: vi.fn(),
    shotIndex: 2,
    ...overrides,
  }
  await renderWithProviders(<TakesTray {...props} />)
  return props
}

/** 成片区里按从新到旧排的卡。 */
const cards = () =>
  within(screen.getByRole('region', { name: '本组成片' })).getAllByRole('listitem')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TakesTray', () => {
  it('成功卡悬停后，剪刀把这条出片交去编辑，回填把它的镜头组交回当前组', async () => {
    const props = await renderTray([completed, failed, running])
    const card = cards()[2]
    if (card === undefined) throw new Error('缺成功卡')

    await userEvent.hover(card)
    await userEvent.click(within(card).getByRole('button', { name: '编辑视频' }))
    expect(props.onEditVideo).toHaveBeenCalledWith(expect.objectContaining({ id: 'completed' }))
    await userEvent.click(within(card).getByRole('button', { name: '回填提示词' }))
    expect(props.onRefill).toHaveBeenCalledWith(HISTORY_SHOT)
  })

  it('在途卡与失败卡没有剪刀和回填，也不能播：唯一的按钮是置灰的状态位，点了什么都不做', async () => {
    const props = await renderTray([completed, failed, running])
    const [runningCard, failedCard] = cards()
    for (const [card, name] of [
      [runningCard, /^生成中，已用 [\d:]+$/],
      [failedCard, '生成失败'],
    ] as const) {
      if (card === undefined) throw new Error('缺卡')
      await userEvent.hover(card)
      const buttons = within(card).getAllByRole('button')
      expect(buttons).toHaveLength(1)
      expect(buttons[0]).toHaveAccessibleName(name)
      expect(buttons[0]).toHaveAttribute('aria-disabled', 'true')
      await userEvent.click(buttons[0] as HTMLElement)
    }
    expect(props.onPreview).not.toHaveBeenCalled()
    expect(props.onEditVideo).not.toHaveBeenCalled()
    expect(props.onRefill).not.toHaveBeenCalled()
  })

  it.each([
    { name: '生成失败', reason: '上游返回了空结果。', take: failed },
    { name: /^生成中/, reason: '还在生成，出片后可编辑', take: running },
  ])('$reason：聚焦卡上的状态位就说出来', async ({ name, reason, take }) => {
    await renderTray([take])
    act(() => screen.getByRole('button', { name }).focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason)
  })

  it('只读时没有剪刀与回填，播放照旧', async () => {
    await renderTray([completed], { onEditVideo: undefined, onRefill: undefined })
    const card = cards()[0] as HTMLElement
    expect(within(card).queryByRole('button', { name: '编辑视频' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '回填提示词' })).not.toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '播放视频' })).toBeVisible()
  })

  it('只有正文、没记分镜结构的出片，回填置灰并说原因，点了不回填', async () => {
    const props = await renderTray([
      job({ id: 'text-only', outputUrl: 'take.mp4', request: { prompt: '只有正文。' } }),
    ])
    const refill = screen.getByRole('button', { name: '回填提示词' })
    expect(refill).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(refill)
    expect(props.onRefill).not.toHaveBeenCalled()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('没记分镜结构')
    // 剪刀不受影响。
    expect(screen.getByRole('button', { name: '编辑视频' })).toBeEnabled()
  })

  it('播放把产物地址与封面交给灯箱；模型 id 在播放钮的提示里', async () => {
    const props = await renderTray([completed])
    const play = screen.getByRole('button', { name: '播放视频' })
    act(() => play.focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('vendor-a-seedance-2-5')
    await userEvent.click(play)
    expect(props.onPreview).toHaveBeenCalledWith({
      kind: 'video',
      name: '生成的视频',
      poster: expect.stringContaining(`${completed.outputUrl}?x-oss-process=video/snapshot,`),
      url: completed.outputUrl,
    })
  })

  it.each([
    { hasPoster: true, url: 'https://assets.oss-ap-southeast-1.aliyuncs.com/take.mp4', where: 'OSS' },
    { hasPoster: false, url: 'https://example.com/take.mp4', where: '非 OSS' },
  ])(
    '$where 地址：卡上只挂截帧封面、不挂 <video>，截不了帧就不画封面',
    async ({ hasPoster, url }) => {
      await renderTray([job({ id: 'take', outputUrl: url })])
      const poster = screen.queryByRole('img', { name: '生成的视频封面' })
      if (hasPoster)
        expect(poster).toHaveAttribute('src', expect.stringContaining(`${url}?x-oss-process=`))
      else expect(poster).toBeNull()
      expect(document.querySelector('video')).toBeNull()
    },
  )

  it('角标：分辨率、片长、编辑次数有就画，缺了就不画', async () => {
    await renderTray([
      completed,
      job({
        id: 'edit',
        outputUrl: 'e.mp4',
        rangeEndMs: 3000,
        rangeStartMs: 0,
        rootJobId: 'completed',
        sourceJobId: 'completed',
      }),
      job({ createdAt: '2026-09-01T09:00:00Z', id: 'bare', outputUrl: 'bare.mp4', request: {} }),
    ])
    const [full, bare] = cards()
    expect(within(full as HTMLElement).getByText('720p')).toBeVisible()
    expect(within(full as HTMLElement).getByText('0:11')).toBeVisible()
    expect(within(full as HTMLElement).getByRole('img', { name: '编辑过 1 次' })).toBeVisible()
    expect(within(bare as HTMLElement).queryByText(/^\d+p$/)).not.toBeInTheDocument()
    expect(within(bare as HTMLElement).queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument()
    expect(
      within(bare as HTMLElement).queryByRole('img', { name: /^编辑过/ }),
    ).not.toBeInTheDocument()
  })

  it.each([
    { jobs: undefined, when: '还在读' },
    // 只有别的组、图片与编辑段，本组一条出片都没有。
    {
      jobs: [
        job({ id: 'other', outputUrl: 'o.mp4', shotIndex: 3 }),
        job({ id: 'image', kind: 'image', outputUrl: 'i.png', shotIndex: null }),
      ],
      when: '本组没出过片',
    },
  ])('$when 时整块不占位', async ({ jobs }) => {
    await renderTray(jobs)
    expect(screen.queryByRole('region', { name: '本组成片' })).not.toBeInTheDocument()
  })

  it('读取失败时说原因', async () => {
    await renderTray(undefined, { error: '读取视频记录失败' })
    expect(
      within(screen.getByRole('region', { name: '本组成片' })).getByRole('alert'),
    ).toHaveTextContent('读取视频记录失败')
  })
})
