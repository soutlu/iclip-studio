import { describe, expect, it } from 'vitest'
import {
  previewDocument,
  withCaptionsScene,
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
        { code: 'en', values: { txt_t1_title: 'Autumn Linen' } },
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
        { code: 'zh', values: { txt_t1_title: '早秋亚麻' } },
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
      code: 'en',
      values: { cap_a1: 'Hello' },
    })
    expect(html).toMatch(
      /<head>\n<script data-hf-preview-variables>[^\n]*<\/script>\n<base href="https:\/\/preview\.test\/files\/">/,
    )
    expect(previewDocument(film(['cap_a1']), 'https://preview.test/files/')).not.toContain(
      'data-hf-preview-variables',
    )
  })
})

describe('预览按语言放人声', () => {
  const root = (modes: string) =>
    `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n` +
    `<div id="film" data-composition-id="film" data-voice-modes='${modes}'>\n` +
    `<video id="v1" class="clip picture" data-start="0" data-duration="4" src="a.mp4" data-has-audio="true" preload="auto"></video>\n` +
    `<audio id="o1" class="clip audio" data-start="0" data-duration="4" src="b.mp4" data-sync-origin="pair"></audio>\n` +
    `<audio id="m1" class="clip audio" data-start="0" data-duration="4" src="music.mp3"></audio>\n` +
    `<audio id="en1" class="clip audio" data-start="0.5" data-duration="1" src="en.m4a" data-locale="en" data-dub-of="cap-a1"></audio>\n` +
    `<audio id="de1" class="clip audio" data-start="0.5" data-duration="1" src="de.m4a" data-locale="de" data-dub-of="cap-a1"></audio>\n` +
    `</div>\n</body>\n</html>\n`
  const html = root('{"en":{"mode":"dub","voice":null}}')
  const page = (locale: Parameters<typeof previewDocument>[2]) =>
    new DOMParser().parseFromString(
      previewDocument(html, 'https://preview.test/', locale),
      'text/html',
    )
  const sounds = (document: Document) =>
    [...document.querySelectorAll('video, audio')].map((element) => element.id)

  it('原文：配音片段都不在，原声照常', () => {
    const document = page(undefined)
    expect(sounds(document)).toEqual(['v1', 'o1', 'm1'])
    expect(document.getElementById('v1')?.hasAttribute('muted')).toBe(false)
  })

  it('AI 配音的语言：只有这种语言的配音，视频关掉原声、分离出来的原声不在，配乐照常；配音按预览的方式加载', () => {
    const document = page({ code: 'en', values: {} })
    expect(sounds(document)).toEqual(['v1', 'm1', 'en1'])
    const video = document.getElementById('v1')
    expect(video?.getAttribute('muted')).toBe('true')
    expect(video?.hasAttribute('data-has-audio')).toBe(false)
    expect(document.getElementById('en1')?.getAttribute('crossorigin')).toBe('anonymous')
  })

  it('保留原声的语言：配音片段都不在，原声照常', () => {
    const document = page({ code: 'de', values: {} })
    expect(sounds(document)).toEqual(['v1', 'o1', 'm1'])
    expect(document.getElementById('v1')?.hasAttribute('muted')).toBe(false)
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

describe('字幕场景放进预览文档', () => {
  const host =
    '<div id="captions" class="clip" data-track-kind="captions" data-composition-id="captions" data-composition-src="compositions/captions.html"></div>'
  const main = (children: string) =>
    `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body><div id="film" data-composition-id="film">${children}</div></body>\n</html>\n`
  const SCENE =
    '<template>\n<style>.caption{color:#fff}</style>\n<div id="root" data-composition-id="captions"><div id="cap-1" class="clip caption" data-var-text="cap_1">还没存的字</div></div>\n</template>\n'
  const templateOf = (html: string) =>
    new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector<HTMLTemplateElement>('template#captions-template')

  it('按字幕宿主挂载的场景 id 放一个模板，内容是场景文件 <template> 里的那些；宿主和场景文件的地址不动', () => {
    const html = withCaptionsScene(main(`<video id="v1"></video>${host}`), SCENE)
    const template = templateOf(html)
    expect(template?.content.querySelector('style')?.textContent).toBe('.caption{color:#fff}')
    expect(template?.content.getElementById('cap-1')?.textContent).toBe('还没存的字')
    const film = new DOMParser().parseFromString(html, 'text/html')
    expect(film.getElementById('captions')?.getAttribute('data-composition-src')).toBe(
      'compositions/captions.html',
    )
    expect(html).toMatch(/^<!doctype html>\n<html/)
  })

  it('没有字幕场景、没有字幕宿主时原样返回', () => {
    const withHost = main(host)
    expect(withCaptionsScene(withHost, null)).toBe(withHost)
    const bare = main('<video id="v1"></video>')
    expect(withCaptionsScene(bare, SCENE)).toBe(bare)
  })

  it('预览文档里带着模板；字幕宿主隐藏着时不带', () => {
    expect(
      templateOf(previewDocument(main(host), 'https://preview.test/', undefined, SCENE)),
    ).not.toBeNull()
    const hiddenHost = host.replace('<div ', '<div data-hidden ')
    expect(
      templateOf(previewDocument(main(hiddenHost), 'https://preview.test/', undefined, SCENE)),
    ).toBeNull()
  })
})
