import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { filmDraftStorageKey } from './use-film-draft'
import { WholeFilmEditor } from './whole-film-editor'

vi.mock('mediabunny', () => ({
  Input: class {
    getPrimaryAudioTrack = () => Promise.resolve(null)
    dispose = () => {}
  },
  UrlSource: class {},
  MP4: {},
  QTFF: {},
  AudioSampleSink: class {},
  BufferTarget: class {},
  Conversion: {},
  EncodedPacketSink: class {},
  Mp4OutputFormat: class {},
  Output: class {},
}))

const CONVERSATION = 'music-pending'
const SOURCE = '11111111-1111-4111-8111-111111111111'
const AUDIO = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  window.localStorage.clear()
  server.use(
    http.get('*/api/brand-templates', () => HttpResponse.json({ items: [] })),
    http.get('*/api/conversations/:id/film', () =>
      HttpResponse.json({ detail: 'not found' }, { status: 404 }),
    ),
  )
})
afterEach(() => vi.unstubAllGlobals())

const seed = (music: unknown = null) => {
  window.localStorage.setItem(
    filmDraftStorageKey(CONVERSATION),
    JSON.stringify({
      version: 1,
      segments: [{ id: 'segment', sourceJobId: SOURCE, start: 0, end: 2, origin: [0, 2] }],
      texts: {},
      manual: [],
      lanes: [],
      music,
    }),
  )
}

const openEditor = () =>
  renderWithProviders(
    <WholeFilmEditor
      conversationId={CONVERSATION}
      onClose={() => {}}
      task={{ kind: 'ready', taskId: null }}
    />,
  )

it.each([true, false])('音乐 POST 尚未受理时不允许合成，受理结果 accepted=%s', async (accepted) => {
  seed()
  const video = makeGenerationJob({
    id: SOURCE,
    outputUrl: 'https://example.com/source.mp4',
    durationMs: 4000,
  })
  const audio = makeGenerationJob({ id: AUDIO, kind: 'audio', status: 'pending' })
  const records: ReturnType<typeof makeGenerationJob>[] = []
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let posted = false
  let composed = 0
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind')
      return HttpResponse.json({
        items: kind === 'video' ? [video] : kind === 'audio' ? records : [],
      })
    }),
    http.post('*/api/generations/music', async () => {
      posted = true
      await pending
      if (!accepted) return HttpResponse.json({ detail: '音乐提交失败' }, { status: 500 })
      records.push(audio)
      return HttpResponse.json({ generation: audio })
    }),
    http.post('*/api/generations/whole-films', () => {
      composed += 1
      return HttpResponse.json({}, { status: 500 })
    }),
  )
  const user = userEvent.setup()
  await openEditor()
  const compose = await screen.findByRole('button', { name: '合成成片' })
  await waitFor(() => expect(compose).not.toHaveAttribute('aria-disabled', 'true'))
  await user.click(screen.getByRole('button', { name: '添加音乐' }))
  await user.click(screen.getByRole('menuitem', { name: '生成音乐' }))
  await user.type(await screen.findByRole('textbox', { name: '音乐描述' }), '轻快电子音乐')
  await user.click(screen.getByRole('button', { name: '生成' }))
  await waitFor(() => expect(posted).toBe(true))
  expect(compose).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(compose)
  expect(composed).toBe(0)
  await act(async () => release())
  if (accepted) {
    expect(await screen.findByText('音乐生成中，完成后自动对齐')).toBeVisible()
    expect(compose).toHaveAttribute('aria-disabled', 'true')
  } else {
    await waitFor(() => expect(compose).not.toHaveAttribute('aria-disabled', 'true'))
    expect(screen.getByRole('button', { name: '添加音乐' })).toBeVisible()
  }
})

it('恢复的上传音乐当前账号不能读取时明确阻止复用，不提交整片', async () => {
  seed({
    kind: 'upload',
    jobId: AUDIO,
    name: null,
    url: 'https://example.com/music.mp3',
    userStart: 0,
    verifyAccess: true,
  })
  server.use(
    http.get('*/api/generations', ({ request }) =>
      HttpResponse.json({
        items:
          new URL(request.url).searchParams.get('kind') === 'video'
            ? [
                makeGenerationJob({
                  id: SOURCE,
                  outputUrl: 'https://example.com/source.mp4',
                  durationMs: 4000,
                }),
              ]
            : [],
      }),
    ),
    http.get('*/api/generations/:id', () =>
      HttpResponse.json({ detail: 'not found' }, { status: 404 }),
    ),
  )
  await openEditor()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /^当前账号无权使用该上传音乐，无法复用；/,
  )
  expect(screen.getByRole('button', { name: '合成成片' })).toHaveAttribute('aria-disabled', 'true')
})
