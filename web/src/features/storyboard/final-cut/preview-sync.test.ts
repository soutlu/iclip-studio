import type { JsonPatchOp } from '@hyperframes/sdk'
import { describe, expect, it } from 'vitest'
import { FONT_BLOCK_END, FONT_BLOCK_START } from './composition/film'
import { previewSync, type PreviewCaptions, type PreviewFilm } from './preview-sync'
import type { PatchChange } from './undo-history'

const HEAD = '<head><base href="https://p.test/files/token-1/"><!-- fonts --></head>'
const SHOWN: PreviewFilm = {
  html: `<!doctype html><html>${HEAD}<body><div id="film"></div></body></html>`,
  runtimeSrc: 'https://p.test/runtime.js',
  revision: 4,
  step: null,
  locale: null,
  filesRevision: 0,
  captions: null,
}

const main = (...patches: JsonPatchOp[]): PatchChange => ({
  file: 'index.html',
  patches,
  inversePatches: [],
})

/** 主文件的一次改动：总长从 `before` 秒改成 `after` 秒。 */
const totalChange = (before: number, after: number): PatchChange => ({
  file: 'index.html',
  patches: [{ op: 'replace', path: '/metadata/duration', value: after }],
  inversePatches: [{ op: 'replace', path: '/metadata/duration', value: before }],
})

/** `SHOWN` 的下一份：这一步改了 `changes`。 */
const next = (...changes: PatchChange[]): PreviewFilm => ({
  ...SHOWN,
  html: SHOWN.html.replace('<div id="film">', '<div id="film" data-duration="5">'),
  revision: SHOWN.revision + 1,
  step: changes,
})

const VIDEO = {
  html: '<video id="v9" data-hf-id="v9" data-start="1" data-duration="2" preload="auto"></video>',
  parentId: 'film',
  siblingIndex: 0,
}
const AUDIO = { html: '<audio id="a9" data-hf-id="a9"></audio>', parentId: 'film', siblingIndex: 0 }
const HOST = {
  html: '<div id="h9" data-hf-id="h9" data-composition-src="compositions/title.html"></div>',
  parentId: 'film',
  siblingIndex: 0,
}

describe('能直接打进去的', () => {
  it.each<[string, JsonPatchOp[]]>([
    [
      '挪片段、改时长、换行',
      [
        { op: 'replace', path: '/elements/v1/timing/start', value: 3 },
        { op: 'replace', path: '/elements/v1/timing/duration', value: 2 },
        { op: 'replace', path: '/elements/v1/timing/trackIndex', value: 1 },
      ],
    ],
    [
      '加视频、音频',
      [
        { op: 'add', path: '/elements/v9', value: VIDEO },
        { op: 'add', path: '/elements/a9', value: AUDIO },
      ],
    ],
    [
      '删片段（宿主也行）',
      [
        { op: 'remove', path: '/elements/v1' },
        { op: 'remove', path: '/elements/h1' },
      ],
    ],
    [
      '隐藏、静音、音量、从素材第几秒起',
      [
        { op: 'add', path: '/elements/v1/attributes/data-hidden', value: '' },
        { op: 'remove', path: '/elements/v1/attributes/muted' },
        { op: 'replace', path: '/elements/a1/attributes/data-volume', value: '0.5' },
        { op: 'replace', path: '/elements/v1/attributes/data-media-start', value: '2' },
      ],
    ],
    ['叠放次序', [{ op: 'replace', path: '/elements/v1/inlineStyles/zIndex', value: '3' }]],
    [
      '画面上挪视频（SDK moveElement）、缩放、转',
      [
        { op: 'add', path: '/elements/v1/attributes/data-hf-edit-base-x', value: '0' },
        { op: 'add', path: '/elements/v1/attributes/data-x', value: '12' },
        { op: 'add', path: '/elements/v1/inlineStyles/width', value: '300px' },
        { op: 'add', path: '/elements/v1/inlineStyles/boxSizing', value: 'border-box' },
        { op: 'add', path: '/elements/v1/inlineStyles/rotate', value: '15deg' },
      ],
    ],
  ])('%s', (_name, patches) => {
    expect(previewSync(SHOWN, next(main(...patches)))).toEqual({
      kind: 'live',
      patches,
      captions: [],
    })
  })

  it('总长变长、不变', () => {
    expect(previewSync(SHOWN, next(totalChange(8, 9)))).toEqual({
      kind: 'live',
      patches: [{ op: 'replace', path: '/metadata/duration', value: 9 }],
      captions: [],
    })
    expect(previewSync(SHOWN, next(totalChange(8, 8)))).toMatchObject({ kind: 'live' })
  })

  it('一步里几次改动的补丁按先后接起来', () => {
    const first = { op: 'remove', path: '/elements/v1' } as const
    const longer = totalChange(2, 3)
    expect(previewSync(SHOWN, next(main(first), longer))).toEqual({
      kind: 'live',
      patches: [first, ...longer.patches],
      captions: [],
    })
  })
})

describe('要整份重新加载的', () => {
  const MOVE: JsonPatchOp = { op: 'replace', path: '/elements/v1/timing/start', value: 3 }
  const movement = main(MOVE)

  it.each<[string, JsonPatchOp]>([
    ['加贴片、场景（含撤销删除）', { op: 'add', path: '/elements/h9', value: HOST }],
    [
      '改贴片、场景的值',
      { op: 'replace', path: '/elements/h1/attributes/data-variable-values', value: '{}' },
    ],
    ['改变量（字幕的字）', { op: 'replace', path: '/variables/cap_1', value: '新的字' }],
    ['声明变量', { op: 'add', path: '/variableDeclarations/cap_9', value: { id: 'cap_9' } }],
    ['改脚本', { op: 'replace', path: '/script/gsap', value: '' }],
    [
      '没实测过的属性',
      { op: 'replace', path: '/elements/v1/attributes/data-playback-rate', value: '2' },
    ],
    ['没实测过的样式', { op: 'replace', path: '/elements/v1/inlineStyles/opacity', value: '0' }],
    ['改元素的字', { op: 'replace', path: '/elements/t1/text', value: '新的字' }],
  ])('和能打的补丁在同一步里也不行：%s', (_name, patch) => {
    expect(previewSync(SHOWN, next(main(MOVE, patch)))).toEqual({ kind: 'reload' })
  })

  it('总长变短，或者不知道原来多长（运行库的总长只能往长里改）', () => {
    expect(previewSync(SHOWN, next(totalChange(8, 6.5)))).toEqual({ kind: 'reload' })
    expect(
      previewSync(SHOWN, next(main({ op: 'replace', path: '/metadata/duration', value: 9 }))),
    ).toEqual({ kind: 'reload' })
  })

  it('改贴片、场景的时长（运行库只认加载时的时长）；挪、换行照打', () => {
    const withHost = (...changes: PatchChange[]): PreviewFilm => {
      const film = next(...changes)
      return { ...film, html: film.html.replace('</div></body>', `${HOST.html}</div></body>`) }
    }
    const timing = (name: string, value: number): JsonPatchOp => ({
      op: 'replace',
      path: `/elements/h9/timing/${name}`,
      value,
    })
    expect(previewSync(SHOWN, withHost(main(timing('duration', 2))))).toEqual({ kind: 'reload' })
    expect(
      previewSync(SHOWN, withHost(main(timing('start', 1), timing('trackIndex', 2)))),
    ).toMatchObject({ kind: 'live' })
  })

  it('这一步改了不认识的文件，或者还没有字幕场景时改了它', () => {
    const scene: PatchChange = { ...movement, file: 'compositions/captions.html' }
    const other: PatchChange = { ...movement, file: 'compositions/title.html' }
    expect(previewSync(SHOWN, next(movement, scene))).toEqual({ kind: 'reload' })
    expect(previewSync(SHOWN, next(movement, other))).toEqual({ kind: 'reload' })
  })

  it('<head> 里中文字体规则以外的变了（别的样式、基准地址）', () => {
    const fonts = next(movement)
    expect(
      previewSync(SHOWN, {
        ...fonts,
        html: fonts.html.replace('<!-- fonts -->', '<style></style>'),
      }),
    ).toEqual({ kind: 'reload' })
    expect(
      previewSync(SHOWN, { ...fonts, html: fonts.html.replace('token-1', 'token-2') }),
    ).toEqual({ kind: 'reload' })
  })

  it('原文以外的语言下改主文件，或者换了语言', () => {
    expect(previewSync({ ...SHOWN, locale: 'en' }, { ...next(movement), locale: 'en' })).toEqual({
      kind: 'reload',
    })
    expect(previewSync(SHOWN, { ...next(movement), locale: 'en' })).toEqual({ kind: 'reload' })
    expect(previewSync({ ...SHOWN, locale: 'en' }, { ...next(), locale: 'de' })).toEqual({
      kind: 'reload',
    })
  })

  it('序号不连着：中间漏了一份，或是同一份又发一次', () => {
    expect(previewSync(SHOWN, { ...next(movement), revision: SHOWN.revision + 2 })).toEqual({
      kind: 'reload',
    })
    expect(previewSync(SHOWN, { ...next(movement), revision: SHOWN.revision })).toEqual({
      kind: 'reload',
    })
  })

  it('不是编辑换的这一份（打开、换语言……）', () => {
    expect(previewSync(SHOWN, { ...next(), step: null })).toEqual({ kind: 'reload' })
  })

  it('预览还没装好或正在重新加载', () => {
    expect(previewSync(null, next(movement))).toEqual({ kind: 'reload' })
  })

  it('工程里别的文件、运行库地址变了', () => {
    expect(previewSync(SHOWN, { ...next(movement), filesRevision: 1 })).toEqual({
      kind: 'reload',
    })
    expect(
      previewSync(SHOWN, { ...next(movement), runtimeSrc: 'https://p.test/runtime-2.js' }),
    ).toEqual({ kind: 'reload' })
  })
})

describe('字体块', () => {
  const MOVE: JsonPatchOp = { op: 'replace', path: '/elements/v1/timing/start', value: 3 }
  /** `film` 换上字体块：样式表链接 `links`、中文字体规则 `rules`。 */
  const withFonts = (film: PreviewFilm, links: string, rules: string): PreviewFilm => ({
    ...film,
    html: film.html.replace(
      '<!-- fonts -->',
      `${FONT_BLOCK_START}\n${links}<style>\n${rules}\n</style>\n${FONT_BLOCK_END}`,
    ),
  })
  const LINK = '<link rel="stylesheet" href="vendor/fonts/a.css">\n'
  const RULES = '@font-face{src:url(a.woff2);unicode-range:U+5b57}'
  const shown = withFonts(SHOWN, LINK, RULES)

  it('只有中文字体规则变了（改字用到了新字形）：照打，带上新的规则', () => {
    const rules = '@font-face{src:url(a.woff2);unicode-range:U+5b57,U+9f99}'
    expect(previewSync(shown, withFonts(next(main(MOVE)), LINK, rules))).toEqual({
      kind: 'live',
      patches: [MOVE],
      captions: [],
      fonts: `\n${rules}\n`,
    })
  })

  it('规则没变：不带', () => {
    expect(previewSync(shown, withFonts(next(main(MOVE)), LINK, RULES))).toEqual({
      kind: 'live',
      patches: [MOVE],
      captions: [],
    })
  })

  it('字体块里的样式表链接变了、没有字体块了：整份重新加载', () => {
    expect(previewSync(shown, withFonts(next(main(MOVE)), '', RULES))).toEqual({
      kind: 'reload',
    })
    expect(previewSync(shown, next(main(MOVE)))).toEqual({ kind: 'reload' })
  })
})

describe('字幕场景', () => {
  const SCENE = 'compositions/captions.html'
  const captionsOf = (texts: Record<string, string>): PreviewCaptions => ({
    path: SCENE,
    scene: '<template><div id="root" data-hf-id="root"></div></template>',
    captions: new Map(
      Object.entries(texts).map(([id, text]) => [
        id,
        { variable: id.replace('cap-', 'cap_'), text },
      ]),
    ),
  })
  const SOURCE_TEXTS = { 'cap-1': '你好', 'cap-2': '再见' }
  const SUBTITLED: PreviewFilm = { ...SHOWN, captions: captionsOf(SOURCE_TEXTS) }

  /** `shown` 的下一份：这一步改了 `changes`，之后各句显示 `texts`。 */
  const after = (
    shown: PreviewFilm,
    texts: Record<string, string>,
    ...changes: PatchChange[]
  ): PreviewFilm => ({
    ...shown,
    revision: shown.revision + 1,
    step: changes,
    captions: captionsOf(texts),
  })
  const scene = (...patches: JsonPatchOp[]): PatchChange => ({
    file: SCENE,
    patches,
    inversePatches: [],
  })
  const values = (locale: string, ...patches: JsonPatchOp[]): PatchChange => ({
    file: `locales/${locale}.json`,
    patches,
    inversePatches: [],
  })
  const CAPTION_3 = {
    html: '<div id="cap-3" data-hf-id="cap-3" class="clip caption" data-start="5" data-duration="1" data-var-text="cap_3">新的一句</div>',
    parentId: 'root',
    siblingIndex: 2,
  }
  const textOf = (id: string, value: string): JsonPatchOp => ({
    op: 'replace',
    path: `/elements/${id}/text`,
    value,
  })

  describe('原文下', () => {
    it.each<[string, JsonPatchOp[]]>([
      [
        '挪一句、改长短',
        [
          { op: 'replace', path: '/elements/cap-1/timing/start', value: 1.5 },
          { op: 'replace', path: '/elements/cap-1/timing/duration', value: 1 },
        ],
      ],
      ['加一句（撤销删除也是）', [{ op: 'add', path: '/elements/cap-3', value: CAPTION_3 }]],
      ['删一句', [{ op: 'remove', path: '/elements/cap-2' }]],
      [
        '跟着视频片段走、换了所属的片段',
        [{ op: 'replace', path: '/elements/cap-1/attributes/data-caption-of', value: 'clip-2' }],
      ],
      [
        '画面上挪、缩放、转一句',
        [
          { op: 'add', path: '/elements/cap-1/attributes/data-y', value: '-40' },
          { op: 'add', path: '/elements/cap-1/attributes/data-hf-edit-base-y', value: '0' },
          { op: 'add', path: '/elements/cap-1/inlineStyles/height', value: '80px' },
          {
            op: 'add',
            path: '/elements/cap-1/inlineStyles/transform',
            value: 'translateY(-50%) rotate(5deg)',
          },
        ],
      ],
      [
        '改一句的字色、字体（链接没变）',
        [
          { op: 'add', path: '/elements/cap-1/inlineStyles/color', value: '#ff3366' },
          { op: 'remove', path: '/elements/cap-1/inlineStyles/fontFamily' },
        ],
      ],
      [
        '改一句的字号（描边、投影跟着改）',
        [
          { op: 'add', path: '/elements/cap-1/inlineStyles/fontSize', value: '80px' },
          {
            op: 'add',
            path: '/elements/cap-1/inlineStyles/WebkitTextStroke',
            value: '16px #000000',
          },
          {
            op: 'add',
            path: '/elements/cap-1/inlineStyles/textShadow',
            value: '0 2px 6px rgba(0, 0, 0, 0.45)',
          },
        ],
      ],
    ])('场景里%s：直接打', (_name, patches) => {
      expect(previewSync(SUBTITLED, after(SUBTITLED, SOURCE_TEXTS, scene(...patches)))).toEqual({
        kind: 'live',
        patches: [],
        captions: patches,
      })
    })

    it('改一句的字：根上的变量和场景里的字一起打', () => {
      const main: PatchChange = {
        file: 'index.html',
        patches: [
          { op: 'replace', path: '/variables/cap_1', value: '早上好' },
          { op: 'add', path: '/elements/film/inlineStyles/--cap_1', value: '早上好' },
        ],
        inversePatches: [],
      }
      const text = textOf('cap-1', '早上好')
      expect(
        previewSync(
          SUBTITLED,
          after(SUBTITLED, { ...SOURCE_TEXTS, 'cap-1': '早上好' }, main, scene(text)),
        ),
      ).toEqual({ kind: 'live', patches: main.patches, captions: [text] })
    })

    it('加一句、删一句：根上声明、去掉这句的变量也能打', () => {
      const declare: JsonPatchOp = {
        op: 'add',
        path: '/variableDeclarations/cap_3',
        value: { id: 'cap_3', type: 'string', label: '字幕', default: '新的一句' },
      }
      const added = after(
        SUBTITLED,
        { ...SOURCE_TEXTS, 'cap-3': '新的一句' },
        scene({ op: 'add', path: '/elements/cap-3', value: CAPTION_3 }),
        { file: 'index.html', patches: [declare], inversePatches: [] },
      )
      expect(previewSync(SUBTITLED, added)).toMatchObject({ kind: 'live', patches: [declare] })

      const undeclare: JsonPatchOp = { op: 'remove', path: '/variableDeclarations/cap_2' }
      const removed = after(
        SUBTITLED,
        { 'cap-1': '你好' },
        scene({ op: 'remove', path: '/elements/cap-2' }),
        { file: 'index.html', patches: [undeclare], inversePatches: [] },
      )
      expect(previewSync(SUBTITLED, removed)).toMatchObject({ kind: 'live', patches: [undeclare] })
    })

    it('改了别的语言的值表：预览里看不到，什么都不用打', () => {
      expect(
        previewSync(
          SUBTITLED,
          after(SUBTITLED, SOURCE_TEXTS, values('en', { op: 'add', path: '/cap_1', value: 'Hi' })),
        ),
      ).toEqual({ kind: 'live', patches: [], captions: [] })
    })

    it.each<[string, JsonPatchOp]>([
      ['场景的总长', { op: 'replace', path: '/metadata/duration', value: 9 }],
      ['场景里的变量', { op: 'add', path: '/variableDeclarations/x', value: { id: 'x' } }],
      ['单句隐藏', { op: 'add', path: '/elements/cap-1/attributes/data-hidden', value: '' }],
      [
        '改读哪个变量',
        { op: 'replace', path: '/elements/cap-1/attributes/data-var-text', value: 'x' },
      ],
      [
        '单句字体、字色、字号以外的样式',
        { op: 'add', path: '/elements/cap-1/inlineStyles/letterSpacing', value: '2px' },
      ],
      [
        '加要挂载的宿主',
        {
          op: 'add',
          path: '/elements/h9',
          value: { ...CAPTION_3, html: '<div id="h9" data-composition-src="x.html"></div>' },
        },
      ],
    ])('场景里%s：整份重新加载', (_name, patch) => {
      expect(previewSync(SUBTITLED, after(SUBTITLED, SOURCE_TEXTS, scene(patch)))).toEqual({
        kind: 'reload',
      })
    })

    it('根上不是字幕的变量：整份重新加载', () => {
      const title: PatchChange = {
        file: 'index.html',
        patches: [{ op: 'replace', path: '/variables/title', value: '标题' }],
        inversePatches: [],
      }
      expect(previewSync(SUBTITLED, after(SUBTITLED, SOURCE_TEXTS, title))).toEqual({
        kind: 'reload',
      })
    })

    it('字幕场景换了文件：整份重新加载', () => {
      const moved = after(SUBTITLED, SOURCE_TEXTS, scene())
      expect(
        previewSync(SUBTITLED, {
          ...moved,
          captions: { ...captionsOf(SOURCE_TEXTS), path: 'compositions/other.html' },
        }),
      ).toEqual({ kind: 'reload' })
    })
  })

  describe('原文以外的语言下', () => {
    const script = (json: string) =>
      `<script data-hf-preview-variables>window.__hfVariables=${json};</script>`
    /** 套着英文、各句显示 `texts` 的一份；值表的值写在 `<head>` 的脚本里。 */
    const english = (texts: Record<string, string>): PreviewFilm => ({
      ...SUBTITLED,
      html: SUBTITLED.html.replace('<head>', `<head>${script(JSON.stringify(texts))}`),
      locale: 'en',
      captions: captionsOf(texts),
    })
    const SHOWN_EN = english({ 'cap-1': 'Hello', 'cap-2': '再见' })
    /** `SHOWN_EN` 的下一份：这一步改了 `changes`，之后各句显示 `texts`。 */
    const nextEn = (texts: Record<string, string>, ...changes: PatchChange[]): PreviewFilm => ({
      ...english(texts),
      revision: SHOWN_EN.revision + 1,
      step: changes,
    })

    it('改这种语言里一句的字、清空回到原文：给那一句打上显示的字', () => {
      expect(
        previewSync(
          SHOWN_EN,
          nextEn(
            { 'cap-1': 'Hi', 'cap-2': '再见' },
            values('en', { op: 'replace', path: '/cap_1', value: 'Hi' }),
          ),
        ),
      ).toEqual({ kind: 'live', patches: [], captions: [textOf('cap-1', 'Hi')] })
      expect(
        previewSync(
          SHOWN_EN,
          nextEn(
            { 'cap-1': '你好', 'cap-2': '再见' },
            values('en', { op: 'remove', path: '/cap_1' }),
          ),
        ),
      ).toEqual({ kind: 'live', patches: [], captions: [textOf('cap-1', '你好')] })
    })

    it('编辑器每步都重写的总长：没变时照打，变了时整份重新加载', () => {
      const edit = values('en', { op: 'replace', path: '/cap_1', value: 'Hi' })
      const texts = { 'cap-1': 'Hi', 'cap-2': '再见' }
      const kept = totalChange(8, 8)
      expect(previewSync(SHOWN_EN, nextEn(texts, edit, kept))).toEqual({
        kind: 'live',
        patches: kept.patches,
        captions: [textOf('cap-1', 'Hi')],
      })
      expect(previewSync(SHOWN_EN, nextEn(texts, edit, totalChange(8, 9)))).toEqual({
        kind: 'reload',
      })
    })

    it('挪一句：只打挪的补丁', () => {
      const retime: JsonPatchOp = { op: 'replace', path: '/elements/cap-2/timing/start', value: 6 }
      expect(
        previewSync(SHOWN_EN, nextEn({ 'cap-1': 'Hello', 'cap-2': '再见' }, scene(retime))),
      ).toEqual({ kind: 'live', patches: [], captions: [retime] })
    })

    it('撤销删除：先加回那一句，再打上这种语言的字', () => {
      const shown = english({ 'cap-1': 'Hello' })
      const restore = { op: 'add', path: '/elements/cap-2', value: CAPTION_3 } as const
      const declare: JsonPatchOp = {
        op: 'add',
        path: '/variableDeclarations/cap_2',
        value: { id: 'cap_2' },
      }
      const restored: PreviewFilm = {
        ...english({ 'cap-1': 'Hello', 'cap-2': 'Bye' }),
        revision: shown.revision + 1,
        step: [
          values('en', { op: 'add', path: '/cap_2', value: 'Bye' }),
          { file: 'index.html', patches: [declare], inversePatches: [] },
          scene(restore),
        ],
      }
      expect(previewSync(shown, restored)).toEqual({
        kind: 'live',
        patches: [declare],
        captions: [restore, textOf('cap-2', 'Bye')],
      })
    })

    it('改原文的字：场景里的字照打，再打回这种语言显示的字', () => {
      const text = textOf('cap-2', '回头见')
      const main: PatchChange = {
        file: 'index.html',
        patches: [{ op: 'replace', path: '/variables/cap_2', value: '回头见' }],
        inversePatches: [],
      }
      expect(
        previewSync(SHOWN_EN, nextEn({ 'cap-1': 'Hello', 'cap-2': '回头见' }, main, scene(text))),
      ).toEqual({ kind: 'live', patches: main.patches, captions: [text, text] })
    })

    it('改了别的语言的值表：什么都不用打', () => {
      expect(
        previewSync(
          SHOWN_EN,
          nextEn(
            { 'cap-1': 'Hello', 'cap-2': '再见' },
            values('de', { op: 'add', path: '/cap_1', value: 'Hallo' }),
          ),
        ),
      ).toEqual({ kind: 'live', patches: [], captions: [] })
    })

    it('这种语言里改贴片、场景的字：整份重新加载', () => {
      expect(
        previewSync(
          SHOWN_EN,
          nextEn(
            { 'cap-1': 'Hello', 'cap-2': '再见' },
            values('en', { op: 'add', path: '/txt_h1_title', value: 'Title' }),
          ),
        ),
      ).toEqual({ kind: 'reload' })
    })
  })
})

describe('智能调音', () => {
  const CLIPS = '<video id="v1" data-hf-id="v1"></video><audio id="a1" data-hf-id="a1"></audio>'
  /** 预览那一份里有 `v1`、`a1` 的 `shown`（套着语言 `locale`），和它的下一份（这一步改了 `patches`）。 */
  const films = (patches: JsonPatchOp[], locale: PreviewFilm['locale'] = null) => {
    const html = SHOWN.html.replace('<div id="film">', `<div id="film">${CLIPS}`)
    const shown: PreviewFilm = { ...SHOWN, html, locale }
    return [shown, { ...shown, revision: shown.revision + 1, step: [main(...patches)] }] as const
  }
  const attribute = (id: string, name: string, value?: string): JsonPatchOp =>
    value === undefined
      ? { op: 'remove', path: `/elements/${id}/attributes/${name}` }
      : { op: 'replace', path: `/elements/${id}/attributes/${name}`, value }

  it.each<[string, JsonPatchOp[]]>([
    [
      '音色风格、均衡、升降调、效果（效果链和曲线）',
      [attribute('a1', 'data-fx-chain', '{}'), attribute('a1', 'data-automation', '{}')],
    ],
    ['拖音量关键帧', [attribute('v1', 'data-automation', '{}')]],
    ['关掉音量关键帧（去掉曲线）', [attribute('v1', 'data-automation')]],
    [
      '平稳音量（效果链和曲线）',
      [
        { op: 'add', path: '/elements/a1/attributes/data-fx-chain', value: '{}' },
        { op: 'add', path: '/elements/a1/attributes/data-automation', value: '{}' },
      ],
    ],
    [
      '自动压低：设置、效果链、曲线，人声放进人声组',
      [
        attribute('a1', 'data-fx-carve', '{}'),
        attribute('a1', 'data-fx-chain', '{}'),
        attribute('a1', 'data-automation', '{}'),
        attribute('v1', 'data-audio-group', 'voice'),
      ],
    ],
    ['声音角色', [attribute('a1', 'data-audio-group', 'sfx')]],
  ])('原地打：%s', (_name, patches) => {
    const [shown, next] = films(patches)
    expect(previewSync(shown, next)).toEqual({ kind: 'live', patches, captions: [] })
  })

  it('要改的片段不在预览那一份里（别的语言的配音片段、隐藏的片段）：整份重新加载', () => {
    const [shown, next] = films([
      attribute('a1', 'data-fx-carve', '{}'),
      attribute('dub-en', 'data-audio-group', 'voice'),
    ])
    expect(previewSync(shown, next)).toEqual({ kind: 'reload' })
  })

  it('原文以外的语言下照样原地打；片段不在、或者同一步里有别的改动时整份重新加载', () => {
    const fx = attribute('a1', 'data-fx-chain', '{}')
    const [shown, next] = films([fx], 'en')
    expect(previewSync(shown, next)).toEqual({ kind: 'live', patches: [fx], captions: [] })
    // 编辑器每步都重写一次总长
    const total = totalChange(8, 8)
    const withTotal: PatchChange = {
      file: 'index.html',
      patches: [fx, ...total.patches],
      inversePatches: total.inversePatches,
    }
    expect(previewSync(shown, { ...next, step: [withTotal] })).toEqual({
      kind: 'live',
      patches: withTotal.patches,
      captions: [],
    })
    // 总长变了：这种语言下整份重新加载
    const longer = totalChange(8, 9)
    expect(
      previewSync(shown, {
        ...next,
        step: [{ ...longer, patches: [fx, ...longer.patches] }],
      }),
    ).toEqual({ kind: 'reload' })

    const [, absent] = films([attribute('dub-de', 'data-fx-chain', '{}')], 'en')
    expect(previewSync(shown, absent)).toEqual({ kind: 'reload' })
    const [, moved] = films(
      [fx, { op: 'replace', path: '/elements/a1/timing/start', value: 3 }],
      'en',
    )
    expect(previewSync(shown, moved)).toEqual({ kind: 'reload' })
  })
})
