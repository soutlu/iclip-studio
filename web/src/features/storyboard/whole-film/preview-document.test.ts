import { describe, expect, it } from 'vitest'
import { card, draftOf, fixtureCatalog as catalog, sentence, video } from '@/testing/whole-film'
import type { WholeFilmDraft } from './editing/draft'
import { compositionMedia, previewState } from './preview-document'

const ORIGIN = 'https://studio.example.com'

const subtitles = {
  s1: { subtitleJobId: 'sub-1', sentences: [sentence(200, 900, '你好世界')] },
}

const mediaOf = (
  draft: WholeFilmDraft,
  urls: Record<string, string> = { s1: 'https://oss/s1.mp4' },
) =>
  compositionMedia(draft, {
    videoUrl: (jobId) => urls[jobId],
    musicUrl: 'https://oss/song.wav',
    subtitles,
  })

describe('预览页', () => {
  it.each([
    [
      '组件库里没有的组件',
      draftOf([card('c1', 1_000, { component: 'nope' }), video('v1', 's1', 0, 1_000)]),
      { s1: 'https://oss/s1.mp4' },
      /组件库.*组件/,
    ],
    ['素材还没有地址', draftOf([video('v1', 's1', 0, 1_000)]), {}, /素材.*地址/],
  ])('合成不了（%s）时给一句话，不带组件 id', (_, draft, urls, message) => {
    const state = previewState(draft, mediaOf(draft, urls), catalog, ORIGIN)
    expect(state).toEqual({
      kind: 'blocked',
      message: expect.stringMatching(message),
    })
    if (state.kind === 'blocked') expect(state.message).not.toContain('nope')
  })
})
