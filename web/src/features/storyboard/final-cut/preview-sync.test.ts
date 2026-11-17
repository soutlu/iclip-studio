import type { JsonPatchOp } from '@hyperframes/sdk'
import { describe, expect, it } from 'vitest'
import { previewSync, type PreviewFilm } from './preview-sync'
import type { PatchChange } from './undo-history'

const HEAD = '<head><base href="https://p.test/files/token-1/"><!-- fonts --></head>'
const SHOWN: PreviewFilm = {
  html: `<!doctype html><html>${HEAD}<body><div id="film"></div></body></html>`,
  runtimeSrc: 'https://p.test/runtime.js',
  revision: 4,
  step: null,
  foreign: false,
  filesRevision: 0,
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
  ])('%s', (_name, patches) => {
    expect(previewSync(SHOWN, next(main(...patches)))).toEqual({ kind: 'live', patches })
  })

  it('总长变长、不变', () => {
    expect(previewSync(SHOWN, next(totalChange(8, 9)))).toEqual({
      kind: 'live',
      patches: [{ op: 'replace', path: '/metadata/duration', value: 9 }],
    })
    expect(previewSync(SHOWN, next(totalChange(8, 8)))).toMatchObject({ kind: 'live' })
  })

  it('一步里几次改动的补丁按先后接起来', () => {
    const first = { op: 'remove', path: '/elements/v1' } as const
    const longer = totalChange(2, 3)
    expect(previewSync(SHOWN, next(main(first), longer))).toEqual({
      kind: 'live',
      patches: [first, ...longer.patches],
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

  it('这一步也改了字幕场景或值表', () => {
    const scene: PatchChange = { ...movement, file: 'compositions/captions.html' }
    const values: PatchChange = { ...movement, file: 'locales/en.json' }
    expect(previewSync(SHOWN, next(movement, scene))).toEqual({ kind: 'reload' })
    expect(previewSync(SHOWN, next(movement, values))).toEqual({ kind: 'reload' })
  })

  it('<head> 变了（字体块、基准地址）', () => {
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

  it('外语', () => {
    expect(previewSync(SHOWN, { ...next(movement), foreign: true })).toEqual({ kind: 'reload' })
    expect(previewSync({ ...SHOWN, foreign: true }, next(movement))).toEqual({ kind: 'reload' })
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
