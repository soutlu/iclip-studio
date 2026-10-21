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

  it('用合成构建生成：素材片地址、组件段、字幕都在页里', () => {
    const draft = draftOf(
      [card('c1', 1_500, { component: 'logo-sting' }), video('v1', 's1', 0, 1_000)],
      { captions: { component: 'default-caption', edits: [] } },
    )
    const state = ready(draft)
    expect(state.durationMs).toBe(2_500)
    expect(state.html).toContain('data-composition-id="main"')
    expect(state.html).toContain('src="https://oss/s1.mp4"')
    expect(state.html).toMatch(/data-composition-src="[^"]*logo-sting/)
    expect(state.html).toMatch(/data-composition-src="compositions\/iclip\/default-caption\.html"/)
    expect(state.html).toContain('&quot;text&quot;:&quot;世&quot;')
  })

  it('画面轨上只有组件段（还没有画布）：也生成预览页，画面是竖屏 1080×1920', () => {
    const draft = draftOf([
      card('c1', 1_500, { component: 'logo-sting' }),
      card('c2', 2_000, { component: 'logo-outro' }),
    ])
    expect(draft.canvas).toBeNull()
    const state = ready(draft)
    expect(state.durationMs).toBe(3_500)
    expect(state.html).toContain('data-width="1080" data-height="1920"')
    expect(state.html).toMatch(/data-composition-src="[^"]*logo-sting/)
    expect(state.html).toMatch(/data-composition-src="[^"]*logo-outro/)
  })

  it('画面轨还是空的时不生成，说明原因', () => {
    expect(previewState(draftOf([]), mediaOf(draftOf([])), catalog, ORIGIN)).toEqual({
      kind: 'blocked',
      message: expect.stringMatching(/成片.*没有画面/),
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
