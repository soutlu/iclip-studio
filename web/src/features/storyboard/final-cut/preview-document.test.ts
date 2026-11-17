import { describe, expect, it } from 'vitest'
import {
  previewDocument,
  withLocalizedHosts,
  withoutHiddenClips,
  withPreviewVariables,
} from './preview-document'

const declarations = (ids: string[]) =>
  JSON.stringify(ids.map((id) => ({ id, type: 'string', label: '字幕', default: `${id} 原文` })))

const film = (ids: string[]) =>
  `<!doctype html>\n<html data-composition-variables='${declarations(ids)}'>\n<head>\n<meta charset="utf-8">\n</head>\n<body><div data-composition-id="film"></div></body>\n</html>\n`

/** 预览文档里套值的脚本写的值；没有这段脚本时是 undefined。 */
const injected = (html: string): unknown => {
  const script = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector('script[data-hf-preview-variables]')
  if (script === null) return undefined
  const match = /^window\.__hfVariables=(.*);$/s.exec(script.textContent)
  return match?.[1] === undefined ? null : JSON.parse(match[1])
}

describe('预览套上一种语言的值', () => {
  it('原文（没有值表）不插脚本，文件原样', () => {
    const html = film(['cap_a1'])
    expect(withPreviewVariables(html, null)).toBe(html)
  })

  it('其它语言：在 <head> 开头插脚本，只放主文件根上声明过的 id；没翻的句子不写', () => {
    const html = withPreviewVariables(film(['cap_a1', 'cap_b2']), {
      cap_a1: 'Hello',
      cap_gone: 'Old line',
    })
    expect(injected(html)).toEqual({ cap_a1: 'Hello' })
    expect(html).toMatch(/<head>\n<script data-hf-preview-variables>/)
  })

  it('一句都没翻也插一段空的', () => {
    expect(injected(withPreviewVariables(film(['cap_a1']), {}))).toEqual({})
  })

  it('值里的 < 写成转义：</script> 不会提前结束脚本，读回来和原来一样', () => {
    const tricky = '</script><script>alert(1)</script> & <b>'
    const html = withPreviewVariables(film(['cap_a1']), { cap_a1: tricky })
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script>')
    expect(injected(html)).toEqual({ cap_a1: tricky })
  })

  describe('贴片、场景里随语言的字', () => {
    // 一个贴片：title 随语言、brand 固定；一个没有随语言字段的贴片；字幕宿主
    const bound = (values: Record<string, unknown>) =>
      `<!doctype html>\n<html data-composition-variables='${JSON.stringify([
        { id: 'txt_t1_title', type: 'string', label: '标题', default: '早秋亚麻' },
        { id: 'txt_t1_sub', type: 'string', label: '副标题', default: '松弛感' },
      ])}'>\n<head>\n<meta charset="utf-8">\n</head>\n<body><div data-composition-id="film">` +
      `<div id="t1" data-composition-id="fixture-fields" data-variable-values='${JSON.stringify(values)}' data-locale-bindings='{"title":"txt_t1_title","sub":"txt_t1_sub"}'></div>` +
      `<div id="t2" data-composition-id="fixture-fields" data-variable-values='{"title":"固定的字"}'></div>` +
      `<div id="captions" data-track-kind="captions" data-composition-src="compositions/captions.html"></div>` +
      `</div></body>\n</html>\n`
    const valuesOf = (html: string, id: string): unknown => {
      const json = new DOMParser()
        .parseFromString(html, 'text/html')
        .getElementById(id)
        ?.getAttribute('data-variable-values')
      return json === null || json === undefined ? null : JSON.parse(json)
    }

    it('其它语言：宿主的取值里随语言的字段换成这种语言的字，没翻的用原文；固定的字段、别的宿主、字幕宿主不动', () => {
      const html = previewDocument(
        bound({ title: '早秋亚麻', brand: 'AUTUMN' }),
        'https://preview.test/files/',
        { txt_t1_title: 'Autumn Linen' },
      )
      expect(valuesOf(html, 't1')).toEqual({
        title: 'Autumn Linen',
        sub: '松弛感',
        brand: 'AUTUMN',
      })
      expect(valuesOf(html, 't2')).toEqual({ title: '固定的字' })
      expect(valuesOf(html, 'captions')).toBeNull()
      expect(html).toMatch(/^<!doctype html>\n<html/)
      expect(injected(html)).toEqual({ txt_t1_title: 'Autumn Linen' })
    })

    it('原文是英文、预览中文值表：随语言的字段和字幕的变量都是中文，没翻的用英文原文', () => {
      const english = (values: Record<string, unknown>) =>
        bound(values)
          .replaceAll('早秋亚麻', 'Autumn Linen')
          .replaceAll('松弛感', 'Easy fit')
          .replaceAll('固定的字', 'Fixed')
      const html = previewDocument(
        english({ title: 'Autumn Linen', brand: 'AUTUMN' }),
        'https://preview.test/files/',
        { txt_t1_title: '早秋亚麻' },
      )
      expect(valuesOf(html, 't1')).toEqual({ title: '早秋亚麻', sub: 'Easy fit', brand: 'AUTUMN' })
      expect(injected(html)).toEqual({ txt_t1_title: '早秋亚麻' })
    })

    it('原文不改宿主；其它语言下没有随语言字段的文件原样', () => {
      const html = bound({ title: '早秋亚麻' })
      expect(valuesOf(previewDocument(html, 'https://preview.test/files/'), 't1')).toEqual({
        title: '早秋亚麻',
      })
      expect(withLocalizedHosts(html, null)).toBe(html)
      const plain = film(['cap_a1'])
      expect(withLocalizedHosts(plain, { cap_a1: 'Hello' })).toBe(plain)
    })
  })

  it('预览文档：脚本排在 <head> 最前面，基准地址和媒体加载方式照旧', () => {
    const html = previewDocument(film(['cap_a1']), 'https://preview.test/files/', {
      cap_a1: 'Hello',
    })
    expect(html).toMatch(
      /<head>\n<script data-hf-preview-variables>[^\n]*<\/script>\n<base href="https:\/\/preview\.test\/files\/">/,
    )
    expect(previewDocument(film(['cap_a1']), 'https://preview.test/files/')).not.toContain(
      'data-hf-preview-variables',
    )
  })
})

describe('隐藏的片段不进预览', () => {
  const head =
    `<!doctype html>\n<html data-composition-variables='[]'>\n<head>\n<meta charset="utf-8">\n` +
    `<style>#film .picture{inset:0}</style>\n</head>\n<body>\n`
  const open = `<div id="film" data-composition-id="film" data-no-timeline data-start="0" data-duration="8">\n`
  const close = `</div>\n</body>\n</html>\n`
  // 没隐藏的片段；宿主里面一层的元素带着隐藏标记，不在根下这一层
  const shown =
    `<video id="v1" class="clip picture" data-start="0" data-duration="4" src="a.mp4" preload="auto"></video>\n` +
    `<div id="t1" class="clip component" data-composition-id="fixture-fields" data-composition-src="t.html">` +
    `<span id="inner" data-hidden>里面的不动</span></div>\n`
  const hidden =
    `<video data-hidden="" id="v2" class="clip picture" data-start="0" data-duration="4" src="b.mp4" preload="auto"></video>\n` +
    `<audio data-hidden="" id="music-1" class="clip audio" data-start="0" data-duration="8" src="m.mp3"></audio>\n` +
    `<div data-hidden="" id="t2" class="clip component" data-composition-id="fixture-fields" data-composition-src="t.html"></div>\n` +
    `<div id="captions" class="clip" data-track-kind="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-hidden></div>\n`
  const parsed = (html: string) => new DOMParser().parseFromString(html, 'text/html')
  const rootChildren = (html: string) =>
    [...(parsed(html).getElementById('film')?.children ?? [])].map((child) => child.id)

  it('去掉根下这一层隐藏的视频、音频、贴片宿主和字幕宿主；没隐藏的、不在这一层的、文档类型和 <head> 都在', () => {
    const html = withoutHiddenClips(`${head}${open}${hidden}${shown}${close}`)
    expect(rootChildren(html)).toEqual(['v1', 't1'])
    expect(html).toMatch(/^<!doctype html>\n<html/)
    const film = parsed(html)
    expect(film.getElementById('inner')).not.toBeNull()
    expect(film.querySelector('head style')?.textContent).toBe('#film .picture{inset:0}')
    expect(film.documentElement.getAttribute('data-composition-variables')).toBe('[]')
  })

  it('根外面带隐藏标记的元素不动', () => {
    const html = withoutHiddenClips(
      `${head}<div id="outside" data-hidden="">根外面</div>\n${open}${hidden}${shown}${close}`,
    )
    expect(parsed(html).getElementById('outside')).not.toBeNull()
    expect(rootChildren(html)).toEqual(['v1', 't1'])
  })

  it('没有隐藏的片段时原样返回', () => {
    const html = `${head}${open}${shown}${close}`
    expect(withoutHiddenClips(html)).toBe(html)
  })

  it('预览文档的根下只剩没隐藏的片段', () => {
    const html = previewDocument(`${head}${open}${hidden}${shown}${close}`, 'https://preview.test/')
    expect(rootChildren(html)).toEqual(['v1', 't1'])
  })
})
