import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { USER_QUERY_KEY } from '@/shared/auth/session'
import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { makeGenerationJob } from '@/testing/generation-job'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { VIDEO_MODELS } from '@/testing/video-models'
import type { ShotsDocument } from '../shot-document'
import type { GenerationJob } from '../storyboard.api'
import { StoryboardReader } from './storyboard-reader'

const PATH = 'video_shot.json'
const CONVERSATION_ID = '4f3c2b1a-0e9d-4c8b-a7f6-5e4d3c2b1a09'
const DRAFT_MODEL = 'vendor-a-seedance-2-5'
const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${PATH}`,
  source: { kind: 'file', path: PATH, version: 1 },
  title: '分镜',
  type: 'storyboard',
}
const document: ShotsDocument = {
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      seconds: 5,
      image_urls: ['https://example.com/model.png'],
      prompt: {
        global_settings: '人物保持一致。',
        timeline: [{ timestamps: [0, 5], prompt: '模特走向镜头 @Image1。', image_indexes: [1] }],
      },
    },
  ],
}

const take = (overrides: Partial<GenerationJob>) =>
  makeGenerationJob({ outputUrl: 'https://example.com/take.mp4', shotIndex: 1, ...overrides })
const draft = take({
  createdAt: '2026-09-01T10:00:00Z',
  id: '1b0d7c2e-3f4a-4b5c-8d6e-7f8091a2b3c4',
  request: { model: DRAFT_MODEL, provider_options: { draft: true }, resolution: '480p' },
})
const plain = take({
  createdAt: '2026-09-01T09:00:00Z',
  id: '2c1e8d3f-4a5b-4c6d-9e7f-8091a2b3c4d5',
  request: { model: DRAFT_MODEL, resolution: '720p' },
})
const fullHd = (status: GenerationJob['status'], createdAt = '2026-09-01T10:05:00Z') =>
  take({
    createdAt,
    id: crypto.randomUUID(),
    outputUrl: status === 'completed' ? 'https://example.com/full-hd.mp4' : null,
    request: { draft_job_id: draft.id, model: DRAFT_MODEL, resolution: '1080p' },
    status,
  })

const serve = (jobs: GenerationJob[], draftModels = VIDEO_MODELS.draftModels) => {
  const videos: VideoGenerationIn[] = []
  const reads = { count: 0 }
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/file', () =>
      HttpResponse.json({ file: { content: JSON.stringify(document), path: PATH, version: 1 } }),
    ),
    http.get('*/api/generations', () => {
      reads.count += 1
      return HttpResponse.json({ items: jobs })
    }),
    http.get('*/api/generations/video-models', () =>
      HttpResponse.json({ ...VIDEO_MODELS, draftModels }),
    ),
    http.post('*/api/generations/video', async ({ request }) => {
      videos.push((await request.json()) as VideoGenerationIn)
      return HttpResponse.json({ task_id: 'b4e1f2a3' }, { status: 202 })
    }),
  )
  return { reads, videos }
}

const renderReader = async (readOnly = false) => {
  const rendered = await renderWithProviders(
    <StoryboardReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={readOnly} />,
    { initialPath: '/?shot=1' },
  )
  await waitFor(() => expect(rendered.queryClient.getQueryData(USER_QUERY_KEY)).toBeTruthy())
  return screen.findByRole('region', { name: '镜头组 1' })
}

const bar = () => screen.getByRole('group', { name: '出片工具栏' })
const qualities = () => within(bar()).getByRole('radiogroup', { name: '分辨率' })
const quality = (name: string) => within(qualities()).getByRole('radio', { name })
const cardOf = async (job: GenerationJob) => {
  const tray = await screen.findByRole('region', { name: '本组素材片' })
  const item = within(tray)
    .getAllByRole('listitem')
    .find((entry) => entry.querySelector('time')?.getAttribute('datetime') === job.createdAt)
  if (item === undefined) throw new Error('素材片区缺这条记录')
  return within(item).getByRole('button')
}
const pickModel = async (name: string) => {
  await userEvent.click(within(bar()).getByRole('button', { name: '视频模型' }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name }))
}

describe('StoryboardReader 样片与转 1080p', () => {
  beforeEach(() => {
    loginAs(mockAuthUser)
  })

  describe('出片工具栏的分辨率分段', () => {
    it.each([
      {
        name: '开通样片',
        draftModels: VIDEO_MODELS.draftModels,
        segments: ['480p', '720p', '样片'],
      },
      { name: '样片没开通', draftModels: [], segments: ['480p', '720p'] },
    ])('$name：分段是 $segments，默认 720p', async ({ draftModels, segments }) => {
      serve([], draftModels)
      await renderReader()
      await waitFor(() =>
        expect(
          within(qualities())
            .getAllByRole('radio')
            .map((item) => item.textContent),
        ).toEqual(segments),
      )
      expect(quality('720p')).toBeChecked()
    })

    it('模型不支持样片：样片置灰、悬停说明原因、点不中；选着样片时换成这种模型回到 720p', async () => {
      serve([])
      await renderReader()
      await waitFor(() =>
        expect(within(bar()).getByRole('button', { name: '视频模型' })).toHaveTextContent(
          DRAFT_MODEL,
        ),
      )
      await userEvent.click(quality('样片'))
      expect(quality('样片')).toBeChecked()

      await pickModel('vendor-a-seedance-2-5-flash')
      expect(quality('720p')).toBeChecked()
      expect(quality('样片')).toHaveAttribute('aria-disabled', 'true')
      await userEvent.click(quality('样片'))
      expect(quality('720p')).toBeChecked()
      expect(await screen.findByRole('tooltip')).toHaveTextContent('该模型不支持样片')

      await pickModel(DRAFT_MODEL)
      expect(quality('720p')).toBeChecked()
      expect(quality('样片')).not.toHaveAttribute('aria-disabled')
    })

    it.each([
      { pick: '720p', resolution: '720p', providerOptions: undefined },
      { pick: '样片', resolution: '480p', providerOptions: { draft: true } },
    ])('选 $pick 出片：分辨率发 $resolution，样片才带 provider_options', async (row) => {
      const { videos } = serve([])
      await renderReader()
      const generate = within(bar()).getByRole('button', { name: '生成第 1 组' })
      await waitFor(() => expect(generate).not.toHaveAttribute('aria-disabled'))
      await userEvent.click(quality(row.pick))
      await userEvent.click(generate)

      await waitFor(() => expect(videos).toHaveLength(1))
      expect(videos[0]).toMatchObject({ model: DRAFT_MODEL, resolution: row.resolution })
      expect(videos[0]?.provider_options).toEqual(row.providerOptions)
    })
  })

  it('样片的卡片标与舞台信息都写「样片」，其他素材片照旧写分辨率', async () => {
    serve([plain, draft])
    const page = await renderReader()

    expect(within(await cardOf(draft)).getByText('样片')).toBeVisible()
    expect(within(await cardOf(plain)).getByText('720p')).toBeVisible()
    await userEvent.click(await cardOf(draft))
    expect(within(page).getByRole('button', { name: /^素材片信息：样片 · / })).toBeVisible()
  })

  describe('舞台上的转 1080p', () => {
    const running = fullHd('submitted')
    const done = fullHd('completed')

    it.each([
      { name: '还没转', jobs: [draft], label: '转 1080p', text: '转 1080p', busy: null },
      {
        name: '转出的那条失败了',
        jobs: [draft, fullHd('failed', '2026-09-01T10:30:00Z')],
        label: '转 1080p',
        text: '转 1080p',
        busy: null,
      },
      {
        name: '正在转',
        jobs: [draft, running],
        label: '正在转 1080p',
        text: '转 1080p',
        busy: 'true',
      },
      { name: '转好了', jobs: [draft, done], label: '查看 1080p', text: '查看 1080p', busy: null },
    ])('$name：按钮是「$label」', async ({ busy, jobs, label, text }) => {
      serve(jobs)
      const page = await renderReader()
      await userEvent.click(await cardOf(draft))

      const action = within(page).getByRole('button', { name: label })
      expect(action).toHaveTextContent(text)
      expect(action).not.toHaveAttribute('aria-disabled')
      expect(action.getAttribute('aria-busy')).toBe(busy)
    })

    it('正在转：悬停提示「正在转 1080p」', async () => {
      serve([draft, running])
      const page = await renderReader()
      await userEvent.click(await cardOf(draft))

      await userEvent.hover(within(page).getByRole('button', { name: '正在转 1080p' }))

      expect(await screen.findByRole('tooltip')).toHaveTextContent('正在转 1080p')
    })

    it.each([
      { name: '正在转', target: running, label: '正在转 1080p' },
      { name: '转好了', target: done, label: '查看 1080p' },
    ])('$name：点按钮选中那张 1080p 卡', async ({ label, target }) => {
      serve([draft, target])
      const page = await renderReader()
      await userEvent.click(await cardOf(draft))

      await userEvent.click(within(page).getByRole('button', { name: label }))

      expect(await cardOf(target)).toHaveAttribute('aria-pressed', 'true')
      expect(await cardOf(draft)).toHaveAttribute('aria-pressed', 'false')
      expect(within(page).queryByRole('button', { name: /1080p$/ })).toBeNull()
    })

    it.each([
      { name: '还没转', jobs: [draft], label: '转 1080p', shown: false },
      { name: '转好了', jobs: [draft, done], label: '查看 1080p', shown: true },
    ])('只读、$name：「$label」按钮出现 $shown', async ({ jobs, label, shown }) => {
      serve(jobs)
      const page = await renderReader(true)
      await userEvent.click(await cardOf(draft))
      await within(page).findByRole('button', { name: /^素材片信息/ })

      expect(within(page).queryByRole('button', { name: label }) !== null).toBe(shown)
    })

    it.each([
      { name: '普通素材片', selected: plain },
      { name: '转出的 1080p', selected: done },
      {
        name: '还在出的样片',
        selected: { ...draft, outputUrl: null, status: 'submitted' as const },
      },
      { name: '失败的样片', selected: { ...draft, status: 'failed' as const } },
    ])('选中$name时没有转 1080p 的按钮', async ({ selected }) => {
      serve([selected, done])
      const page = await renderReader()
      await userEvent.click(await cardOf(selected))
      await within(page).findByRole('button', { name: /^素材片信息/ })

      expect(within(page).queryByRole('button', { name: /1080p$/ })).toBeNull()
    })

    it('点「转 1080p」提交这条样片，在途时再点不重复提交，受理后重读视频记录', async () => {
      const { reads } = serve([draft])
      const bodies: unknown[] = []
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      server.use(
        http.post('*/api/generations/video-draft-completions', async ({ request }) => {
          bodies.push(await request.json())
          await gate
          return HttpResponse.json({ generation: running }, { status: 202 })
        }),
      )
      const page = await renderReader()
      await userEvent.click(await cardOf(draft))
      const convert = within(page).getByRole('button', { name: '转 1080p' })

      await userEvent.click(convert)
      await userEvent.click(convert)
      await waitFor(() => expect(bodies).toHaveLength(1))
      const readsBefore = reads.count
      release()

      await waitFor(() => expect(reads.count).toBeGreaterThan(readsBefore))
      expect(bodies).toEqual([{ conversationId: CONVERSATION_ID, draftJobId: draft.id }])
    })

    it('转 1080p 被拒：后端给的原因写在出片工具栏的状态行', async () => {
      serve([draft])
      server.use(
        http.post('*/api/generations/video-draft-completions', () =>
          HttpResponse.json({ detail: '样片已过期，无法转 1080p' }, { status: 422 }),
        ),
      )
      const page = await renderReader()
      await userEvent.click(await cardOf(draft))

      await userEvent.click(within(page).getByRole('button', { name: '转 1080p' }))

      expect(
        await within(bar()).findByRole('alert', { name: /样片已过期，无法转 1080p/ }),
      ).toBeVisible()
    })
  })
})
