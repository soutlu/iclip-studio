import { openComposition, type Composition } from '@hyperframes/sdk'
import { describe, expect, it } from 'vitest'
import { fixtureCatalog } from '@/testing/final-cut'
import {
  CAPTIONS_PATH,
  CAPTIONS_PROBLEM_TEXT,
  captionElement,
  captionOf,
  captionsHostElement,
  captionsProblem,
  captionsScene,
  captionStyles,
  captionVariable,
  isCaptionsHost,
} from './captions'

const CANVAS = { width: 1080, height: 1920 }

const first = { id: 'cap-a1', start: 400, duration: 2200, variable: 'cap_a1', text: '第一句' }
const second = {
  id: 'cap-b2',
  start: 2800,
  duration: 1500,
  variable: 'cap_b2',
  text: '第二句\n换一行 <b>',
}

/** 场景根下每个带时间的元素读成字幕，`texts` 是主文件根上的变量。 */
const readCaptions = (scene: Composition, texts: ReadonlyMap<string, string> = new Map()) => {
  const timings = scene.getElementTimings()
  const root = scene.getRootElements().find((element) => element.attributes['data-composition-id'])
  return (root?.children ?? []).flatMap((element) => {
    const timing = timings[element.id]
    return timing === undefined ? [] : [captionOf(element, timing, texts)]
  })
}

const tagOf = (html: string, id: string) =>
  new RegExp(`<div id="${id}"[^>]*>`).exec(html)?.[0] ?? ''

describe('字幕场景文件', () => {
  it('读成几句：时间、变量；字取主文件根上的变量，没有变量时取元素里写的字', async () => {
    const scene = await openComposition(captionsScene(CANVAS, fixtureCatalog, [first, second]))
    const captions = readCaptions(scene, new Map([['cap_a1', '根上的字']]))
    expect(captions).toEqual([
      expect.objectContaining({
        kind: 'caption',
        id: 'cap-a1',
        start: 400,
        duration: 2200,
        variable: 'cap_a1',
        text: '根上的字',
      }),
      expect.objectContaining({
        id: 'cap-b2',
        start: 2800,
        duration: 1500,
        variable: 'cap_b2',
        text: '第二句\n换一行 <b>',
      }),
    ])
  })

  it('SDK 存回去仍是 <template> 包着；场景根带 data-no-timeline，场景不声明变量', async () => {
    const scene = await openComposition(captionsScene(CANVAS, fixtureCatalog, [first]))
    scene.setTiming('cap-a1', { start: 1 })
    const saved = scene.serialize()
    expect(saved.trim().startsWith('<template>')).toBe(true)
    expect(saved.trim().endsWith('</template>')).toBe(true)
    const root = tagOf(saved, 'root')
    expect(root).toContain('data-composition-id="captions"')
    expect(root).toMatch(/ data-no-timeline[ =>]/)
    expect(saved).not.toContain('data-composition-variables')
    expect(readCaptions(await openComposition(saved))[0]?.start).toBe(1000)
  })

  it('一句字幕的元素：带时间、读变量，字里的 HTML 转义、换行写成 <br>', () => {
    const written = captionElement(second)
    expect(written).toBe(
      '<div id="cap-b2" data-hf-id="cap-b2" class="clip caption" data-start="2.8" data-duration="1.5" data-var-text="cap_b2">第二句<br>换一行 &lt;b&gt;</div>',
    )
  })

  it('属于视频片段的字幕写上 data-caption-of，存回去再读还认得；手动加的不属于任何片段', async () => {
    const scene = await openComposition(
      captionsScene(CANVAS, fixtureCatalog, [{ ...first, owner: 'clip-1' }, second]),
    )
    expect(tagOf(scene.serialize(), 'cap-a1')).toContain('data-caption-of="clip-1"')
    const reread = readCaptions(await openComposition(scene.serialize()))
    expect(reread.map((caption) => caption.owner)).toEqual(['clip-1', null])
  })

  it('一句设了字体和字色：写在它元素的行内样式上，存回去再读还认得；别的句和没设过的是 null（默认样式）', async () => {
    const scene = await openComposition(captionsScene(CANVAS, fixtureCatalog, [first, second]))
    expect(readCaptions(scene).map(({ font, color }) => ({ font, color }))).toEqual([
      { font: null, color: null },
      { font: null, color: null },
    ])
    scene.setStyle(
      'cap-a1',
      captionStyles({ font: 'Playfair Display', color: '#ff3366' }, fixtureCatalog, CANVAS),
    )
    const saved = scene.serialize()
    expect(saved).toContain(
      `<div style="font-family: 'Playfair Display', '${fixtureCatalog.cjk.family}', sans-serif; color: #ff3366" id="cap-a1"`,
    )
    const reread = await openComposition(saved)
    expect(readCaptions(reread).map(({ font, color }) => ({ font, color }))).toEqual([
      { font: 'Playfair Display', color: '#ff3366' },
      { font: null, color: null },
    ])

    // 改回默认：去掉行内样式，只改给了的那一样
    reread.setStyle('cap-a1', captionStyles({ font: null }, fixtureCatalog, CANVAS))
    expect(readCaptions(reread)[0]).toMatchObject({ font: null, color: '#ff3366' })
  })

  it('字体只能是组件库里的字体族，字色只能是 #rrggbb', () => {
    expect(() => captionStyles({ font: 'Comic Sans MS' }, fixtureCatalog, CANVAS)).toThrow(
      '组件库里没有字体「Comic Sans MS」',
    )
    expect(() => captionStyles({ color: 'red' }, fixtureCatalog, CANVAS)).toThrow()
    expect(captionStyles({ color: '#00FF00' }, fixtureCatalog, CANVAS)).toEqual({
      color: '#00FF00',
    })
    expect(captionStyles({ font: null, color: null }, fixtureCatalog, CANVAS)).toEqual({
      fontFamily: null,
      color: null,
    })
  })

  it('一句设了字号：行内写上字号和按它算的描边、投影，存回去再读还认得；回到默认时三样一起去掉，别的样式留着', async () => {
    const scene = await openComposition(captionsScene(CANVAS, fixtureCatalog, [first, second]))
    expect(readCaptions(scene).map((caption) => caption.fontSize)).toEqual([null, null])
    scene.setStyle('cap-a1', captionStyles({ color: '#ff3366' }, fixtureCatalog, CANVAS))
    scene.setStyle('cap-a1', captionStyles({ fontSize: 100 }, fixtureCatalog, CANVAS))
    const saved = scene.serialize()
    expect(saved).toContain(
      '<div style="color: #ff3366; font-size: 100px; -webkit-text-stroke: 20px #000000; text-shadow: 0 3px 8px rgba(0, 0, 0, 0.45)" id="cap-a1"',
    )
    const reread = await openComposition(saved)
    expect(readCaptions(reread).map((caption) => caption.fontSize)).toEqual([100, null])

    reread.setStyle('cap-a1', captionStyles({ fontSize: null }, fixtureCatalog, CANVAS))
    expect(reread.serialize()).toContain('<div style="color: #ff3366" id="cap-a1"')
    expect(readCaptions(reread)[0]).toMatchObject({ fontSize: null, color: '#ff3366' })
  })

  it('字号是默认字号 0.5 倍到 2 倍之间的整数像素，超出、不是整数时报错', () => {
    // 1080 宽时默认 56
    expect(captionStyles({ fontSize: 28 }, fixtureCatalog, CANVAS)).toMatchObject({
      fontSize: '28px',
    })
    expect(captionStyles({ fontSize: 112 }, fixtureCatalog, CANVAS)).toMatchObject({
      fontSize: '112px',
    })
    for (const size of [27, 113, 40.5, Number.NaN])
      expect(() => captionStyles({ fontSize: size }, fixtureCatalog, CANVAS)).toThrow(
        '字幕字号要是 28 到 112 之间的整数像素',
      )
  })

  it('行内的字号不是整数像素时读成默认（null）', async () => {
    const scene = await openComposition(captionsScene(CANVAS, fixtureCatalog, [first, second]))
    scene.setStyle('cap-a1', { fontSize: '2em' })
    scene.setStyle('cap-b2', { fontSize: '40.5px' })
    expect(readCaptions(scene).map((caption) => caption.fontSize)).toEqual([null, null])
  })

  it('字幕的样子写在场景里：字体是组件库的中文字体，后面只跟通用字体', () => {
    const scene = captionsScene(CANVAS, fixtureCatalog)
    expect(scene).toContain(`font-family: '${fixtureCatalog.cjk.family}', sans-serif;`)
    expect(scene).toContain('top: 86.5%;')
    expect(scene).toContain('font-size: 56px;')
    expect(scene).toContain('-webkit-text-stroke: 11px #000000;')
    expect(scene).toContain('text-shadow: 0 2px 4px rgba(0, 0, 0, 0.45);')
    expect(captionsScene({ width: 1920, height: 1080 }, fixtureCatalog)).toContain(
      'font-size: 100px;',
    )
  })
})

describe('主文件里的字幕宿主和变量', () => {
  it('宿主挂载字幕场景、带 data-no-timeline、不带取值', () => {
    const written = captionsHostElement(CANVAS, 6500)
    expect(written).toContain(`data-composition-src="${CAPTIONS_PATH}"`)
    expect(written).toContain('data-composition-id="captions"')
    expect(written).toContain('data-duration="6.5"')
    expect(written).toMatch(/ data-no-timeline /)
    expect(written).not.toContain('data-variable-values')
    expect(
      isCaptionsHost({ 'data-track-kind': 'captions', 'data-composition-src': 'x.html' }),
    ).toBe(true)
    expect(isCaptionsHost({ 'data-composition-src': 'x.html' })).toBe(false)
  })

  it('每句一个变量：字是默认值', () => {
    expect(captionVariable(first)).toEqual({
      id: 'cap_a1',
      type: 'string',
      label: '字幕',
      role: 'content',
      default: '第一句',
    })
  })
})

describe('字幕写法的检查', () => {
  const scene = captionsScene(CANVAS, fixtureCatalog, [first])
  const host = { 'data-track-kind': 'captions', 'data-composition-src': CAPTIONS_PATH }
  const declarations = `data-composition-variables='[{"id":"x","type":"string","label":"x","default":"y"}]'`

  it('编辑器写的没问题', () => {
    expect(captionsProblem(scene, host)).toBeUndefined()
    expect(captionsProblem(null, undefined)).toBeUndefined()
  })

  it('场景根 <div> 上声明了变量', () => {
    const declared = scene.replace('data-no-timeline', `data-no-timeline ${declarations}`)
    expect(captionsProblem(declared, host)).toBe(CAPTIONS_PROBLEM_TEXT)
  })

  it('场景文件写成完整文档、在 <html> 上声明了变量', () => {
    const document = `<!doctype html><html ${declarations}><body><div data-composition-id="captions"></div></body></html>`
    expect(captionsProblem(document, host)).toBe(CAPTIONS_PROBLEM_TEXT)
  })

  it('宿主带了取值，哪怕是空的', () => {
    expect(captionsProblem(scene, { ...host, 'data-variable-values': '{}' })).toBe(
      CAPTIONS_PROBLEM_TEXT,
    )
  })
})
