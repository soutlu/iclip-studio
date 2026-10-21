import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ExportControl } from './export-control'
import type { ExportView } from './use-whole-film-export'

const EXPORT_ID = '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b'
const USED = ['1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e']

const DONE: ExportView = {
  kind: 'done',
  exportId: EXPORT_ID,
  downloadUrl: 'https://downloads.example.test/film.mp4',
  sourceJobIds: USED,
}

const enhanceJob = (status: 'submitted' | 'failed' | 'completed') =>
  makeGenerationJob({
    kind: 'video',
    operation: 'enhance',
    outputUrl: status === 'completed' ? 'https://downloads.example.test/film-hd.mp4' : null,
    sourceJobId: EXPORT_ID,
    status,
  })

type Tier = { resolution: '1080p' | '720p'; job: ReturnType<typeof enhanceJob> | null }

const serveTiers = (tiers: Tier[]) => {
  const state = { reads: 0 }
  server.use(
    http.get(`*/api/generations/${EXPORT_ID}/enhancements`, () => {
      state.reads += 1
      return HttpResponse.json({
        downloadedJobIds: USED,
        tiers: tiers.map((tier) => ({ ...tier, mine: true })),
      })
    }),
  )
  return state
}

const renderControl = (view: ExportView) =>
  renderWithProviders(
    <ExportControl blocked={undefined} onCancel={() => {}} onStart={() => {}} view={view} />,
  )

describe('ExportControl · 高清版', () => {
  it.each([
    {
      name: '有在做的一档：写进度',
      tiers: [
        { job: enhanceJob('submitted'), resolution: '1080p' },
        { job: enhanceJob('failed'), resolution: '720p' },
      ] satisfies Tier[],
      text: '正在生成高清版 1080p',
    },
    {
      name: '没有在做的、最近一次没做成：写失败',
      tiers: [
        { job: enhanceJob('completed'), resolution: '1080p' },
        { job: enhanceJob('failed'), resolution: '720p' },
      ] satisfies Tier[],
      text: '高清版 720p 生成失败，请重试',
    },
  ])('导出完成后，状态行跟着这次导出的高清版：$name', async ({ tiers, text }) => {
    serveTiers(tiers)
    await renderControl(DONE)
    expect(await screen.findByRole('status')).toHaveTextContent(text)
  })

  it('都做好或都没做：状态行不出现', async () => {
    const tiers = serveTiers([
      { job: enhanceJob('completed'), resolution: '1080p' },
      { job: null, resolution: '720p' },
    ])
    await renderControl(DONE)
    await waitFor(() => expect(tiers.reads).toBe(1))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each([
    { view: { kind: 'rendering', progress: 0.4 } as const, text: '正在渲染 40%' },
    {
      view: { kind: 'failed', message: '成片渲染失败，请重新导出' } as const,
      text: '成片渲染失败，请重新导出',
    },
  ])('导出自己在进行或失败时，写导出的状态（$text）', async ({ view, text }) => {
    const tiers = serveTiers([{ job: enhanceJob('submitted'), resolution: '1080p' }])
    await renderControl(view)
    expect(screen.getByRole('status')).toHaveTextContent(text)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tiers.reads).toBe(0)
  })

  it('「下载成片」能做高清版时先开菜单，第一项是「下载成片」，按钮上不带状态', async () => {
    const tiers = serveTiers([{ job: enhanceJob('submitted'), resolution: '1080p' }])
    const user = userEvent.setup()
    await renderControl(DONE)
    await waitFor(() => expect(tiers.reads).toBe(1))
    const download = screen.getByRole('button', { name: '下载成片' })
    expect(download).not.toHaveAccessibleDescription()

    await user.click(download)

    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['下载成片', expect.stringMatching(/^正在生成高清版 1080p/)])
  })
})
