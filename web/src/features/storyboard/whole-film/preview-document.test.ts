import { describe, expect, it } from 'vitest'
import { card, draftOf, sentence, video } from '@/testing/whole-film'
import catalogJson from './catalog/catalog.json'
import type { ComponentCatalog } from './component-catalog'
import type { WholeFilmDraft } from './editing/draft'
import { compositionMedia, previewState, withBaseHref } from './preview-document'

const catalog = catalogJson as ComponentCatalog
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

const ready = (draft: WholeFilmDraft) => {
  const state = previewState(draft, mediaOf(draft), catalog, ORIGIN)
  if (state.kind !== 'ready') throw new Error(`预览没生成：${state.message}`)
  return state
}

describe('预览页', () => {
  it('<base> 插在 <head> 后面，指向本站这一版的组件目录', () => {
    expect(withBaseHref('<html><head><meta charset="utf-8"></head></html>', 'https://a/b/')).toBe(
      '<html><head>\n<base href="https://a/b/"><meta charset="utf-8"></head></html>',
    )
    const { html } = ready(draftOf([video('v1', 's1', 0, 1_000)]))
    expect(html).toContain(`<base href="${ORIGIN}/hyperframes/${catalog.version}/">`)
    // 字体 CSS 是相对组件目录的路径，要排在 <base> 之后才按它解析
    const base = html.indexOf('<base ')
    const font = html.indexOf(`<link rel="stylesheet" href="${catalog.runtime.cjkFont}">`)
    expect(font).toBeGreaterThan(base)
  })

  it('用合成构建生成：成片地址、片头组件、字幕都在页里', () => {
    const draft = draftOf([card('c1', 'intro', 1_500), video('v1', 's1', 0, 1_000)], {
      captions: { component: 'default-caption', edits: [] },
    })
    const withIntro: WholeFilmDraft = {
      ...draft,
      layer0: draft.layer0.map((clip) =>
        clip.type === 'component' ? { ...clip, component: 'logo-sting' } : clip,
      ),
    }
    const state = ready(withIntro)
    expect(state.durationMs).toBe(2_500)
    expect(state.html).toContain('data-composition-id="main"')
    expect(state.html).toContain('src="https://oss/s1.mp4"')
    expect(state.html).toMatch(/data-composition-src="[^"]*logo-sting/)
    expect(state.html).toMatch(/data-composition-src="compositions\/iclip\/default-caption\.html"/)
    expect(state.html).toContain('&quot;text&quot;:&quot;世&quot;')
  })

  it('成片里还没有画面时不生成，说明原因', () => {
    expect(previewState(draftOf([]), mediaOf(draftOf([])), catalog, ORIGIN)).toEqual({
      kind: 'blocked',
      message: '成片里还没有画面；加入视频后可以在这里预览',
    })
  })

  it.each([
    [
      '组件库里没有的组件',
      draftOf([card('c1', 'intro', 1_000), video('v1', 's1', 0, 1_000)]),
      { s1: 'https://oss/s1.mp4' },
      '成片里有组件库里没有的组件，暂时无法预览；请删掉它或换一个组件',
    ],
    [
      '素材还没有地址',
      draftOf([video('v1', 's1', 0, 1_000)]),
      {},
      '有素材还没读到地址，暂时无法预览；请稍后再试',
    ],
    [
      '转场超出切点两边',
      draftOf([video('v1', 's1', 0, 300), video('v2', 's1', 0, 300)], {
        transitions: [
          { id: 't1', afterClipId: 'v1', component: 'fade-through', duration: 900, variables: {} },
        ],
      }),
      { s1: 'https://oss/s1.mp4' },
      '有转场超出了切点两边的片段，暂时无法预览；请加长相邻片段或删掉这个转场',
    ],
  ])('合成不了（%s）时给一句话，不带组件 id', (_, draft, urls, message) => {
    expect(previewState(draft, mediaOf(draft, urls), catalog, ORIGIN)).toEqual({
      kind: 'blocked',
      message,
    })
  })
})
