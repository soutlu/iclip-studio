import { describe, expect, it } from 'vitest'
import { previewDocument, withPreviewVariables } from './preview-document'

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
