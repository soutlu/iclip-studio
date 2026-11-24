import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { video } from '@/testing/final-cut'
import {
  CONVERSATION,
  TAKE_A,
  URL_A,
  openEditor,
  putFilm,
  savedVariableTexts,
  sceneLine,
  setUpEditorCase,
  tearDownEditorCase,
  undoButton,
  waitSaved,
} from '@/testing/final-cut-editor'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { putMockWorkspaceFile } from '@/testing/mocks/workspace'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

/** 从镜头组出的素材片：照服务端存的样子，台词写在镜头文字的花括号里。 */
const scriptedTake = makeGenerationJob({
  id: TAKE_A,
  createdAt: '2026-09-01T10:00:00Z',
  outputUrl: URL_A,
  shotIndex: 1,
  durationMs: 6_000,
  metadata: { film_node: 'video-1' },
  request: {
    shot: {
      global_settings: '',
      timeline: [
        { timestamps: [0, 6], prompt: '她看向镜头说{We open at nine.}', image_indexes: [] },
      ],
    },
  },
})

/** 只读已有的字幕识别记录；记下发起识别的素材片。 */
const serveSubtitles = () => {
  const submitted: string[] = []
  const done = makeGenerationJob({
    kind: 'subtitle',
    sourceJobId: TAKE_A,
    sentences: [{ startMs: 0, endMs: 1_500, text: 'We open at ten.', speaker: null, words: [] }],
  })
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const params = new URL(request.url).searchParams
      if (params.get('kind') !== 'subtitle') return undefined
      const source = params.get('sourceJobId')
      return HttpResponse.json({ items: [done].filter((job) => job.sourceJobId === source) })
    }),
    http.post('*/api/generations/subtitles', async ({ request }) => {
      const { sourceJobId } = (await request.json()) as { sourceJobId: string }
      submitted.push(sourceJobId)
      return HttpResponse.json({ detail: '不该发起识别' }, { status: 500 })
    }),
  )
  return submitted
}

describe('final-cut 编辑器 · 字幕对照台词', () => {
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
  const field = () => within(panel()).getByRole('textbox', { name: /^字幕文字 / })
  const adoptButton = () => within(panel()).queryByRole('button', { name: /^采用 .+ 的台词$/ })

  it('识别出的字幕和台词差一个词：原文下出现对照行，「采用」换成台词、对照行收起，撤销后回来；其它语言不显示；不发起识别', async () => {
    await putFilm(
      [video({ src: URL_A, duration: 2_000 })],
      [{ ...sceneLine('a1', 0, 1_500, 'clip-1'), text: 'We open at ten.' }],
    )
    putMockWorkspaceFile(CONVERSATION, 'final-cut/locales/en.json', '{}')
    const user = userEvent.setup()
    await openEditor([scriptedTake])
    const submitted = serveSubtitles()
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
      ).getByRole('tab', { name: '字幕' }),
    )

    expect(await within(panel()).findByRole('deletion')).toHaveTextContent(/^ten$/)
    expect(within(panel()).getByRole('insertion')).toHaveTextContent(/^nine$/)
    expect(within(panel()).getByText('台词')).toBeVisible()

    const adopt = adoptButton()
    if (adopt === null) throw new Error('应有「采用」')
    await user.click(adopt)
    expect(field()).toHaveValue('We open at nine.')
    expect(adoptButton()).toBeNull()
    await waitSaved(() => expect(savedVariableTexts()).toEqual(['We open at nine.']))

    await user.click(undoButton())
    await waitFor(() => expect(field()).toHaveValue('We open at ten.'))
    expect(await within(panel()).findByRole('deletion')).toHaveTextContent(/^ten$/)

    const languages = within(panel()).getByRole('group', { name: '原文与译文' })
    await user.click(within(languages).getByRole('button', { name: 'English（EN）' }))
    await waitFor(() => expect(within(panel()).queryByText('台词')).toBeNull())
    expect(adoptButton()).toBeNull()

    await user.click(within(languages).getByRole('button', { name: '原文' }))
    expect(await within(panel()).findByRole('deletion')).toHaveTextContent(/^ten$/)
    expect(submitted).toEqual([])
  })
})
