import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ExportControl } from './export-control'
import type { ExportView } from './use-whole-film-export'

const EXPORT_ID = '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b'
const FILM_URL = 'https://downloads.example.test/film.mp4'

const DONE: ExportView = {
  kind: 'done',
  exportId: EXPORT_ID,
  downloadUrl: FILM_URL,
  locale: null,
  resolution: null,
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
      return HttpResponse.json({ tiers: tiers.map((tier) => ({ ...tier, mine: true })) })
    }),
  )
  return state
}

const EMPTY_TEXT = 'final-cut 暂无内容，无法导出；请先加入内容'

type Target = ComponentProps<typeof ExportControl>['target']

const SOURCE: Target = { locale: null, untranslated: 0, resolution: null }

const ENGLISH: Target = { locale: 'en', untranslated: 0, resolution: null }

const renderControl = (
  view: ExportView,
  {
    blocked,
    onStart = () => {},
    target = SOURCE,
  }: { blocked?: string; onStart?: () => void; target?: Target } = {},
) =>
  renderWithProviders(
    <ExportControl
      blocked={blocked}
      onCancel={() => {}}
      onStart={onStart}
      target={target}
      view={view}
    />,
  )

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ExportControl · 高清版', () => {
  it('下载成片：保存成功后记这次导出的成片，一条', async () => {
    const tiers = serveTiers([])
    const events: unknown[] = []
    server.use(
      http.post('*/api/tracking/events', async ({ request }) => {
        events.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(
        FILM_URL,
        () => new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } }),
      ),
    )
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = () => 'blob:http://localhost/video'
        static override revokeObjectURL() {}
      },
    )
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await renderControl(DONE)
    await waitFor(() => expect(tiers.reads).toBe(1))

    await userEvent.click(screen.getByRole('button', { name: '下载成片' }))

    await waitFor(() => expect(events).toEqual([{ jobId: EXPORT_ID, name: 'video.downloaded' }]))
    expect(saved).toHaveBeenCalledTimes(1)
  })

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
    {
      view: { kind: 'rendering', progress: 0.4, locale: null, resolution: null } as const,
      text: '正在渲染 40%',
    },
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

  it.each([
    { view: { kind: 'idle' } as const, button: '导出' },
    { view: { kind: 'failed', message: '成片渲染失败，请重新导出' } as const, button: '导出' },
    { view: { kind: 'cancelled' } as const, button: '导出' },
    { view: DONE, button: '重新导出' },
  ])('「$button」点了发起导出；空的 final-cut 禁用，只说明原因', async ({ view, button }) => {
    serveTiers([])
    const user = userEvent.setup()
    const onStart = vi.fn()
    const { unmount } = await renderControl(view, { onStart })
    await user.click(screen.getByRole('button', { name: new RegExp(`^${button}$`) }))
    expect(onStart).toHaveBeenCalledTimes(1)
    unmount()

    onStart.mockClear()
    await renderControl(view, { blocked: EMPTY_TEXT, onStart })
    const start = screen.getByRole('button', { name: new RegExp(`^${button}$`) })
    expect(start).toHaveAttribute('aria-disabled', 'true')
    await user.click(start)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(EMPTY_TEXT)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('提交中：「导出」转圈禁用，状态说正在提交', async () => {
    const onStart = vi.fn()
    const user = userEvent.setup()
    await renderControl({ kind: 'starting', locale: null, resolution: null }, { onStart })
    expect(screen.getByRole('status')).toHaveTextContent('正在提交导出…')
    const start = screen.getByRole('button', { name: /导出/ })
    expect(start).toHaveAttribute('aria-disabled', 'true')
    await user.click(start)
    expect(onStart).not.toHaveBeenCalled()
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

describe('ExportControl · 语言', () => {
  it.each([
    {
      view: { kind: 'starting', locale: 'en', resolution: null } as const,
      text: '正在提交 English 版导出…',
    },
    {
      view: { kind: 'queued', ahead: 0, locale: 'de', resolution: null } as const,
      text: 'Deutsch 版排队中，即将开始',
    },
    {
      view: { kind: 'queued', ahead: 2, locale: 'en', resolution: null } as const,
      text: 'English 版排队中，前方还有 2 个导出',
    },
    {
      view: { kind: 'rendering', progress: null, locale: 'en', resolution: null } as const,
      text: '正在渲染 English 版…',
    },
    {
      view: { kind: 'rendering', progress: 0.4, locale: 'fr', resolution: null } as const,
      text: '正在渲染 Français 版 40%',
    },
    {
      view: { kind: 'uploading', locale: 'es', resolution: null } as const,
      text: '正在上传 Español 版成片…',
    },
    { view: { kind: 'uploading', locale: null, resolution: null } as const, text: '正在上传成片…' },
    {
      view: { kind: 'starting', locale: 'zh', resolution: null } as const,
      text: '正在提交中文版导出…',
    },
    {
      view: { kind: 'queued', ahead: 0, locale: 'zh', resolution: null } as const,
      text: '中文版排队中，即将开始',
    },
    {
      view: { kind: 'rendering', progress: 0.4, locale: 'zh', resolution: null } as const,
      text: '正在渲染中文版 40%',
    },
    {
      view: { kind: 'rendering', progress: null, locale: null, resolution: null } as const,
      text: '正在渲染…',
    },
  ])('进行中的状态写这次导出的语言，原文不写（$text）', async ({ view, text }) => {
    // 状态跟着这次导出走，不看编辑器现在显示的语言
    await renderControl(view, { target: SOURCE })
    expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${text}$`))
  })

  it('其它语言的导出完成后状态写「已导出 English 版」；高清版在做时先说高清版；原文完成不写', async () => {
    serveTiers([])
    const { unmount } = await renderControl({ ...DONE, locale: 'en' })
    expect(await screen.findByRole('status')).toHaveTextContent(/^已导出 English 版$/)
    unmount()

    const chinese = await renderControl({ ...DONE, locale: 'zh' })
    expect(await screen.findByRole('status')).toHaveTextContent(/^已导出中文版$/)
    chinese.unmount()

    serveTiers([{ job: enhanceJob('submitted'), resolution: '1080p' }])
    await renderControl({ ...DONE, locale: 'en' })
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('正在生成高清版 1080p'),
    )
  })

  it.each([
    { view: { kind: 'idle' } as const, button: '导出' },
    { view: { ...DONE, locale: 'en', resolution: null } as const, button: '重新导出' },
  ])(
    '当前是其它语言：「$button」的提示写导出哪种语言的版本，有没翻的文字时提醒条数，照样能导',
    async ({ view, button }) => {
      serveTiers([])
      const user = userEvent.setup()
      const onStart = vi.fn()
      const { unmount } = await renderControl(view, { onStart, target: ENGLISH })
      await user.hover(screen.getByRole('button', { name: new RegExp(`^${button}$`) }))
      expect(await screen.findByRole('tooltip')).toHaveTextContent(/^导出 English 版$/)
      unmount()

      const untranslated = await renderControl(view, {
        onStart,
        target: { ...ENGLISH, untranslated: 3 },
      })
      const start = screen.getByRole('button', { name: new RegExp(`^${button}$`) })
      await user.hover(start)
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        /^导出 English 版；有 3 条文字未翻译，导出后显示原文$/,
      )
      expect(start).not.toHaveAttribute('aria-disabled')
      await user.click(start)
      expect(onStart).toHaveBeenCalledTimes(1)
      untranslated.unmount()

      await renderControl(view, {
        onStart,
        target: { locale: 'zh', untranslated: 2, resolution: null },
      })
      await user.hover(screen.getByRole('button', { name: new RegExp(`^${button}$`) }))
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        /^导出中文版；有 2 条文字未翻译，导出后显示原文$/,
      )
    },
  )

  it('当前是原文没有提示；被拦时只说拦的原因', async () => {
    const user = userEvent.setup()
    const { unmount } = await renderControl({ kind: 'idle' }, { target: SOURCE })
    await user.hover(screen.getByRole('button', { name: '导出' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    unmount()

    await renderControl({ kind: 'idle' }, { blocked: EMPTY_TEXT, target: ENGLISH })
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new RegExp(`^${EMPTY_TEXT}$`))
  })
})

describe('ExportControl · 导出分辨率', () => {
  it.each([
    {
      view: { kind: 'starting', locale: null, resolution: '720p' } as const,
      text: '正在提交 720P 导出…',
    },
    {
      view: { kind: 'queued', ahead: 0, locale: null, resolution: '480p' } as const,
      text: '480P 排队中，即将开始',
    },
    {
      view: { kind: 'rendering', progress: 0.4, locale: 'en', resolution: '720p' } as const,
      text: '正在渲染 English 版 720P 40%',
    },
    {
      view: { kind: 'uploading', locale: 'zh', resolution: '720p' } as const,
      text: '正在上传中文版 720P 成片…',
    },
  ])('进行中的状态写这次导出的档位，跟在语言后面（$text）', async ({ view, text }) => {
    await renderControl(view, { target: SOURCE })
    expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${text}$`))
  })

  it('完成后写「已导出 720P」「已导出 English 版 720P」', async () => {
    serveTiers([])
    const { unmount } = await renderControl({ ...DONE, resolution: '720p' })
    expect(await screen.findByRole('status')).toHaveTextContent(/^已导出 720P$/)
    unmount()

    await renderControl({ ...DONE, locale: 'en', resolution: '720p' })
    expect(await screen.findByRole('status')).toHaveTextContent(/^已导出 English 版 720P$/)
  })

  it('选了和画面不同的档：「导出」的提示写导出哪一档，其它语言时跟在语言后面', async () => {
    const user = userEvent.setup()
    const { unmount } = await renderControl(
      { kind: 'idle' },
      { target: { ...SOURCE, resolution: '720p' } },
    )
    await user.hover(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^导出 720P$/)
    unmount()

    await renderControl({ kind: 'idle' }, { target: { ...ENGLISH, resolution: '720p' } })
    await user.hover(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^导出 English 版 720P$/)
  })
})
