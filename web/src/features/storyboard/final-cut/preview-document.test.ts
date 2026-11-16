import { describe, expect, it } from 'vitest'
import { previewDocument, withLocalizedHosts, withPreviewVariables } from './preview-document'

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
  it('中文（没有值表）不插脚本，文件原样', () => {
    const html = film(['cap_a1'])
    expect(withPreviewVariables(html, null)).toBe(html)
  })

  it('外语：在 <head> 开头插脚本，只放主文件根上声明过的 id；没翻的句子不写', () => {
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

    it('外语：宿主的取值里随语言的字段换成这种语言的字，没翻的用中文原文；固定的字段、别的宿主、字幕宿主不动', () => {
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

    it('中文不改宿主；外语下没有随语言字段的文件原样', () => {
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
