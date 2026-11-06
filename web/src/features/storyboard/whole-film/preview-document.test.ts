import { describe, expect, it } from 'vitest'
import { card, draftOf, fixtureCatalog as catalog, sentence, video } from '@/testing/whole-film'
import { buildComposition } from './composition/build'
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
  describe('预览模式', () => {
    const PREVIEW_MARK = '<meta name="hyperframes-studio-preview" content="1">'
    const draft = draftOf([video('v1', 's1', 0, 1_000), video('v2', 's1', 0, 1_000)])
    const videoTags = (html: string) => html.match(/<video [^>]*>/g) ?? []

    it('预览页的视频跨域加载、初始不预读，页头带预览标记', () => {
      const state = previewState(draft, mediaOf(draft), catalog, ORIGIN)
      if (state.kind !== 'ready') throw new Error(`预览没生成：${state.message}`)
      const { html } = state
      expect(videoTags(html)).toHaveLength(2)
      for (const tag of videoTags(html)) {
        expect(tag).toContain('crossorigin="anonymous"')
        expect(tag).toContain('preload="none"')
      }
      expect(html.slice(html.indexOf('<head'), html.indexOf('</head>'))).toContain(PREVIEW_MARK)
    })

    it('合成构建的输出不变，渲染服务那条路不受影响', () => {
      const { html } = buildComposition({ draft, media: mediaOf(draft), catalog })
      expect(videoTags(html)).toHaveLength(2)
      for (const tag of videoTags(html)) expect(tag).toContain('preload="auto"')
      expect(html).not.toContain('crossorigin')
      expect(html).not.toContain('hyperframes-studio-preview')
    })
  })

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
