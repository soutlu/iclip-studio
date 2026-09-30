import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { renderWithProviders } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import { takesOfShot } from '../takes'
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
  const onSelect = vi.fn<(jobId: string) => void>()
  await renderWithProviders(
    <TakesTray
      error={undefined}
      onSelect={onSelect}
      selectedId={undefined}
      takes={jobs === undefined ? undefined : takesOfShot(jobs, 2, '9:16')}
      {...overrides}
    />,
  )
  return { onSelect }
}

/** 成片区里按从新到旧排的卡。 */
const cards = () =>
  within(screen.getByRole('region', { name: '本组成片' })).getAllByRole('listitem')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TakesTray', () => {
  it('整张卡是唯一的按钮：成功、在途、失败都能点，点了交出这条记录；卡上没有别的操作', async () => {
    const { onSelect } = await renderTray([completed, failed, running])
    const names = [/生成中$/, /生成失败$/, /的成片$/]
    for (const [index, card] of cards().entries()) {
      const buttons = within(card).getAllByRole('button')
      expect(buttons).toHaveLength(1)
      expect(buttons[0]).toHaveAccessibleName(names[index])
      await userEvent.click(buttons[0] as HTMLElement)
    }
    expect(onSelect.mock.calls).toEqual([['running'], ['failed'], ['completed']])
  })

  it('选中的那张标 aria-pressed，其余不标', async () => {
    await renderTray([completed, failed, running], { selectedId: 'failed' })
    expect(
      cards().map((card) => within(card).getByRole('button').getAttribute('aria-pressed')),
    ).toEqual(['false', 'true', 'false'])
  })

  it.each([
    {
      hasPoster: true,
      url: 'https://assets.oss-ap-southeast-1.aliyuncs.com/take.mp4',
      where: 'OSS',
    },
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
