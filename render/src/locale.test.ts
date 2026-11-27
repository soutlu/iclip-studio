import { describe, expect, it } from 'vitest'
import {
  checkLocaleValues,
  localizeProject,
  readLocaleTable,
  rootDeclarations,
  withLocalizedHosts,
  withLocalizedVoices,
} from './locale'

const attr = (value: unknown) => JSON.stringify(value).replaceAll('"', '&quot;')

const DECLARATIONS = [
  { id: 'cap_a1', type: 'string', label: '字幕', default: '你好' },
  { id: 'txt_t1_text', type: 'string', label: '文字', default: '成片标题' },
  { id: 'txt_t1_tag', type: 'string', label: '角标', default: '新品' },
  {
    id: 'mode',
    type: 'enum',
    label: '模式',
    default: 'a',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
]

/** 一份主文件：随语言的元素片段 t1、没有随语言字段的元素片段 t2、字幕宿主；属性写法照编辑器写出的样子。 */
const MAIN = `<!doctype html>
<html data-composition-variables="${attr(DECLARATIONS)}">
<head><meta charset="utf-8"></head>
<body>
<div id="film" data-composition-id="film">
  <div id="t1" class="clip component" data-composition-src="compositions/a.html" data-variable-values="${attr({ text: '成片标题', tag: '新品', accent: '#ff0000' })}" data-locale-bindings="${attr({ text: 'txt_t1_text', tag: 'txt_t1_tag' })}"></div>
  <div id="t2" class="clip component" data-composition-src="compositions/a.html" data-variable-values="${attr({ text: '固定的字' })}"></div>
  <div id="captions" class="clip" data-track-kind="captions" data-composition-src="compositions/captions.html"></div>
</div>
</body>
</html>
`

const T1_BEFORE = `data-variable-values="${attr({ text: '成片标题', tag: '新品', accent: '#ff0000' })}"`

const files = (table: string | null) => [
  { path: 'index.html', content: MAIN },
  { path: 'compositions/a.html', content: '<template></template>' },
  ...(table === null ? [] : [{ path: 'locales/en.json', content: table }]),
]

describe('读值表', () => {
  it('工程里的 locales/<语言>.json 是一个 JSON 对象', () => {
    expect(readLocaleTable(files('{"cap_a1":"Hello"}'), 'en')).toEqual({
      ok: true,
      value: { cap_a1: 'Hello' },
    })
  })

  it('工程里没有这种语言的值表、别的语言的不算', () => {
    expect(readLocaleTable(files(null), 'en')).toMatchObject({ ok: false })
    expect(readLocaleTable(files('{}'), 'de')).toMatchObject({ ok: false })
  })

  it.each(['不是 JSON', '[]', '"Hello"', 'null'])('不是 JSON 对象（%s）', (content) => {
    const result = readLocaleTable(files(content), 'en')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
  })
})

describe('根上的声明', () => {
  it('读 <html> 上的 data-composition-variables，写法不对的声明不算', () => {
    const html = `<html data-composition-variables="${attr([
      ...DECLARATIONS.slice(0, 1),
      { id: 'broken', type: 'string' },
      { id: 'n', type: 'number', label: '数', default: 'x' },
    ])}"><body></body></html>`
    expect(rootDeclarations(html).map((declaration) => declaration.id)).toEqual(['cap_a1'])
  })

  it('没写或写法不对时当作没有声明', () => {
    expect(rootDeclarations('<html><body></body></html>')).toEqual([])
    expect(rootDeclarations('<html data-composition-variables="{"><body></body></html>')).toEqual(
      [],
    )
  })
})

describe('校验值表', () => {
  const declarations = rootDeclarations(MAIN)

  it('没声明的变量去掉，记去掉了几条', () => {
    expect(
      checkLocaleValues({ cap_a1: 'Hello', old_1: 'Gone', old_2: 'Gone' }, declarations),
    ).toEqual({ ok: true, value: { values: { cap_a1: 'Hello' }, dropped: 2 } })
  })

  it('类型不对整份不用，说明是哪个变量、不泄露具体取值', () => {
    const checked = checkLocaleValues({ cap_a1: 42, old: 'x' }, declarations)
    expect(checked.ok).toBe(false)
    if (!checked.ok) {
      expect(checked.message).toContain('cap_a1')
      expect(checked.message).not.toContain('42')
    }
  })

  it('不在可选范围里也整份不用，且不泄露原值', () => {
    const checked = checkLocaleValues({ mode: '秘密的值' }, declarations)
    expect(checked.ok).toBe(false)
    if (!checked.ok) {
      expect(checked.message).toContain('mode')
      expect(checked.message).not.toContain('秘密的值')
    }
  })
})

describe('改宿主取值', () => {
  const defaults = new Map(
    rootDeclarations(MAIN).map((declaration) => [declaration.id, declaration.default]),
  )

  it('只改随语言的宿主：随语言的字段换成这种语言的字，没翻的用根变量的默认值，固定的字段照旧；别的字一个不动', () => {
    const localized = withLocalizedHosts(MAIN, { txt_t1_text: 'Title' }, defaults)
    const after = `data-variable-values="${attr({ text: 'Title', tag: '新品', accent: '#ff0000' })}"`

    expect(localized).toBe(MAIN.replace(T1_BEFORE, after))
  })

  it('没有随语言的宿主时原样返回', () => {
    const html = MAIN.replace(/ data-locale-bindings="[^"]*"/, '')
    expect(withLocalizedHosts(html, { txt_t1_text: 'Title' }, defaults)).toBe(html)
  })

  it('宿主上没写取值时加上', () => {
    const html = MAIN.replace(` ${T1_BEFORE}`, '')
    const localized = withLocalizedHosts(html, { txt_t1_text: 'Title' }, defaults)
    expect(localized).toBe(
      html.replace(
        '<div id="t1"',
        `<div data-variable-values="${attr({ text: 'Title', tag: '新品' })}" id="t1"`,
      ),
    )
  })

  it('值里的引号、& 转义后写进属性', () => {
    const localized = withLocalizedHosts(MAIN, { txt_t1_text: 'Tom & "Jerry"' }, defaults)
    expect(localized).toContain(
      `data-variable-values="{&quot;text&quot;:&quot;Tom &amp; \\&quot;Jerry\\&quot;&quot;,`,
    )
  })
})

describe('把工程变成一种语言的版本', () => {
  it('主文件改好宿主取值，别的文件原样；变量值是校验过的值表', () => {
    const table = '{"cap_a1":"Hello","txt_t1_text":"Title","stale":"x"}'
    const localized = localizeProject(files(table), 'en')

    expect(localized).toEqual({
      ok: true,
      value: {
        files: [
          {
            path: 'index.html',
            content: MAIN.replace(
              T1_BEFORE,
              `data-variable-values="${attr({ text: 'Title', tag: '新品', accent: '#ff0000' })}"`,
            ),
          },
          ...files(table).slice(1),
        ],
        variables: { cap_a1: 'Hello', txt_t1_text: 'Title' },
        dropped: 1,
      },
    })
  })

  it('原文是英文、加的是中文：随语言的字段换成中文值表里的字，没翻的用英文原文；变量值是中文值表', () => {
    const english = MAIN.replaceAll('你好', 'Hello')
      .replaceAll('成片标题', 'Film title')
      .replaceAll('新品', 'New')
    const chinese = {
      path: 'locales/zh.json',
      content: '{"cap_a1":"你好","txt_t1_text":"成片标题"}',
    }

    expect(localizeProject([{ path: 'index.html', content: english }, chinese], 'zh')).toEqual({
      ok: true,
      value: {
        files: [
          {
            path: 'index.html',
            content: english.replace(
              attr({ text: 'Film title', tag: 'New', accent: '#ff0000' }),
              attr({ text: '成片标题', tag: 'New', accent: '#ff0000' }),
            ),
          },
          chinese,
        ],
        variables: { cap_a1: '你好', txt_t1_text: '成片标题' },
        dropped: 0,
      },
    })
  })

  it('值表读不了或校验不过时说明原因', () => {
    expect(localizeProject(files(null), 'en')).toMatchObject({ ok: false })
    const invalid = localizeProject(files('{"cap_a1":1}'), 'en')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.message).toContain('cap_a1')
  })
})

describe('按语言放人声', () => {
  const VIDEO =
    '<video id="c1" class="clip picture" data-start="0" data-duration="4" src="https://m.test/a.mp4" data-has-audio="true" playsinline></video>'
  const MUSIC =
    '<audio id="m1" class="clip audio" data-start="0" data-duration="8" src="https://m.test/music.mp3"></audio>'
  const DETACHED =
    '<audio id="v1" class="clip audio" data-start="0" data-duration="4" src="https://m.test/b.mp4" data-sync-origin="pair-1"></audio>'
  const dub = (locale: string, id: string) =>
    `<audio id="${id}" class="clip audio" data-start="0.3" data-duration="1.7" src="https://m.test/dub-${locale}.m4a" data-media-start="0.3" data-locale="${locale}" data-dub-of="cap-a1"></audio>`
  const film = (modes: string | null) =>
    `<!doctype html>\n<html>\n<head></head>\n<body>\n<div id="film" data-composition-id="film"${modes === null ? '' : ` data-voice-modes="${attr(JSON.parse(modes))}"`}>\n` +
    `  ${VIDEO}\n  ${MUSIC}\n  ${DETACHED}\n  ${dub('en', 'd-en')}\n  ${dub('de', 'd-de')}\n</div>\n</body>\n</html>\n`
  const without = (html: string, ...parts: string[]) =>
    parts.reduce((left, part) => left.replace(`\n  ${part}`, ''), html)
  const EN_DUB = '{"en":{"mode":"dub","voice":null}}'

  it('原文：配音片段都去掉，原声照常，别的字一个不动', () => {
    const html = film(EN_DUB)
    expect(withLocalizedVoices(html, null, null)).toBe(
      without(html, dub('en', 'd-en'), dub('de', 'd-de')),
    )
  })

  it('AI 配音：只留这种语言的配音，视频关掉原声、分离出来的原声去掉，配乐不动', () => {
    const html = film(EN_DUB)
    expect(withLocalizedVoices(html, 'en', null)).toBe(
      without(html, DETACHED, dub('de', 'd-de')).replace(
        ' data-has-audio="true" playsinline>',
        ' playsinline muted="true">',
      ),
    )
  })

  it('保留原声：这种语言的配音也去掉，原声照常', () => {
    const html = film(EN_DUB)
    expect(withLocalizedVoices(html, 'de', null)).toBe(
      without(html, dub('en', 'd-en'), dub('de', 'd-de')),
    )
    expect(withLocalizedVoices(film(null), 'en', null)).toBe(
      without(film(null), dub('en', 'd-en'), dub('de', 'd-de')),
    )
  })

  describe('原文下的配音片段：字幕场景里属于视频片段的句子和旁白句分开', () => {
    // 原文下给 cap-a1（属于视频片段 c1）配的音，和旁白 cap-n1（手动加的字幕）
    const SOURCE_TAKE =
      '<audio id="s1" class="clip audio" data-start="0.3" data-duration="1.7" src="https://m.test/s.m4a" data-dub-of="cap-a1" data-dub-text="一" data-dub-voice="original"></audio>'
    const NARRATION =
      '<audio id="n1" class="clip audio" data-start="2" data-duration="1.5" src="https://m.test/narration.m4a" data-dub-of="cap-n1" data-dub-voice="v-1"></audio>'
    const SCENE =
      '<template><div data-composition-id="captions">' +
      '<div id="cap-a1" class="clip caption" data-var-text="cap_a1" data-caption-of="c1">一</div>' +
      '<div id="cap-n1" class="clip caption" data-var-text="cap_n1">旁白</div>' +
      '</div></template>'
    const withSource = (modes: string) =>
      film(modes).replace(`\n  ${MUSIC}`, `\n  ${MUSIC}\n  ${SOURCE_TAKE}\n  ${NARRATION}`)

    it('原文原声、外语原声：只留旁白；外语配音：都去掉', () => {
      const html = withSource(EN_DUB)
      for (const locale of [null, 'de'] as const) {
        const voiced = withLocalizedVoices(html, locale, SCENE)
        expect(voiced).toContain(NARRATION)
        expect(voiced).not.toContain(SOURCE_TAKE)
      }
      const english = withLocalizedVoices(html, 'en', SCENE)
      expect(english).not.toContain(NARRATION)
      expect(english).not.toContain(SOURCE_TAKE)
    })

    it('原文配音：原文下的都留着，视频关掉原声，外语配音去掉', () => {
      const voiced = withLocalizedVoices(
        withSource('{"_source":{"mode":"dub","voice":null}}'),
        null,
        SCENE,
      )
      expect(voiced).toContain(SOURCE_TAKE)
      expect(voiced).toContain(NARRATION)
      expect(voiced).toContain(' playsinline muted="true">')
      expect(voiced).not.toContain('d-en')
    })

    it('按语言导出时从字幕宿主挂载的场景文件里读', () => {
      const HOST =
        '<div id="captions" class="clip" data-composition-id="captions" data-composition-src="compositions/captions.html" data-track-kind="captions" data-start="0" data-duration="8"></div>'
      const main = withSource(EN_DUB).replace(`\n  ${MUSIC}`, `\n  ${MUSIC}\n  ${HOST}`)
      const project = [
        { path: 'index.html', content: main },
        { path: 'compositions/captions.html', content: SCENE },
      ]
      const source = localizeProject(project, null)
      const content = source.ok ? (source.value.files[0]?.content ?? '') : ''
      expect(content).toContain(NARRATION)
      expect(content).not.toContain(SOURCE_TAKE)
    })
  })

  it('按语言导出用上它：原文去掉配音，English 用 English 的配音', () => {
    const main = film(EN_DUB)
    const project = [
      { path: 'index.html', content: main },
      { path: 'locales/en.json', content: '{}' },
    ]
    const source = localizeProject(project, null)
    expect(source).toMatchObject({ ok: true, value: { variables: null, dropped: 0 } })
    expect(source.ok && source.value.files[0]?.content).toBe(
      without(main, dub('en', 'd-en'), dub('de', 'd-de')),
    )
    const english = localizeProject(project, 'en')
    const content = english.ok ? (english.value.files[0]?.content ?? '') : ''
    expect(content).toContain(dub('en', 'd-en'))
    expect(content).not.toContain('d-de')
    expect(content).not.toContain('data-sync-origin')
  })
})
