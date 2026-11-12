import { openComposition } from '@hyperframes/sdk'
import { describe, expect, it } from 'vitest'
import {
  pictureBlock,
  sourceVariable,
  writeFilm,
  type Film,
  type PictureBlock,
} from '../../web/src/features/storyboard/whole-film/composition/film'
import { checkFilm, FilmProblem, localizedFilm, readFilm } from './film'
import { catalog, SOURCE_JOB } from './testing'

const OTHER_JOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const picture = (overrides: Partial<PictureBlock> = {}): PictureBlock => ({
  id: 'clip-1',
  label: '镜头 1',
  jobId: SOURCE_JOB,
  src: 'https://media.iclip.test/videos/a.mp4?sig=1&v=2',
  start: 0,
  duration: 2000,
  mediaStart: 500,
  track: 0,
  volume: 1,
  ...overrides,
})

const second = (overrides: Partial<PictureBlock> = {}): PictureBlock =>
  picture({
    id: 'clip-2',
    label: '镜头 2',
    jobId: OTHER_JOB,
    src: 'https://media.iclip.test/videos/b.mp4',
    start: 2000,
    duration: 3000,
    mediaStart: 1000,
    volume: 0.5,
    ...overrides,
  })

const film = (...blocks: PictureBlock[]): Film => ({ canvas: { width: 720, height: 1280 }, blocks })
const html = (...blocks: PictureBlock[]) => writeFilm(film(...blocks), catalog)

describe('checkFilm', () => {
  it('写出来的成片读回来是同一份，重写后一字不差', async () => {
    const written = html(picture(), second())
    const checked = await checkFilm(written, catalog)
    expect(checked.film).toEqual(film(picture(), second()))
    expect(checked.html).toBe(written)
    expect(checked.durationMs).toBe(5000)
    expect(checked.sources).toEqual([
      { jobId: SOURCE_JOB, url: 'https://media.iclip.test/videos/a.mp4?sig=1&v=2' },
      { jobId: OTHER_JOB, url: 'https://media.iclip.test/videos/b.mp4' },
    ])
  })

  it('还没有块的成片也能通过', async () => {
    const checked = await checkFilm(html(), catalog)
    expect(checked.film.blocks).toEqual([])
    expect(checked.durationMs).toBe(0)
    expect(checked.sources).toEqual([])
  })

  it('同一条素材片用两次只算一个素材', async () => {
    const again = picture({ id: 'clip-2', start: 2000, mediaStart: 3000 })
    const checked = await checkFilm(html(picture(), again), catalog)
    expect(checked.sources).toHaveLength(1)
  })

  it('用 SDK 加块、存出来的文件通过检查，重写后 SDK 再开再存仍然通过且内容不变', async () => {
    const session = await openComposition(html())
    const add = (block: PictureBlock, index: number) =>
      session.batch(() => {
        session.declareVariable(sourceVariable(block.jobId, block.src))
        session.addElement('film', index, pictureBlock(block))
        session.dispatch({
          type: 'setCompositionMetadata',
          duration: (block.start + block.duration) / 1000,
        })
      })
    add(picture(), 0)
    add(second(), 1)
    const first = await checkFilm(session.serialize(), catalog)
    expect(first.film).toEqual(film(picture(), second()))
    expect(first.html).toBe(html(picture(), second()))

    const reopened = await openComposition(first.html)
    reopened.setTiming('clip-2', { start: 2.5 })
    const moved = await checkFilm(reopened.serialize(), catalog)
    expect(moved.film.blocks[1]).toMatchObject({ id: 'clip-2', start: 2500, duration: 3000 })
    expect(moved.durationMs).toBe(5500)
  })

  it('合写法却过不了渲染前的检查（组件库里没有用到的字体）：拒收，原因只进排障信息', async () => {
    const fontless = { ...catalog, cjk: { ...catalog.cjk, slices: [] } }
    const problem = await checkFilm(html(picture()), fontless).catch((error: unknown) => error)
    expect(problem).toBeInstanceOf(FilmProblem)
    expect((problem as FilmProblem).message).toBe('成片文件没通过渲染前的检查')
    expect((problem as FilmProblem).detail).toMatch(/^font_family_without_font_face: /)
  })
})

describe('readFilm 拒收写法之外的东西', () => {
  const base = html(picture(), second())
  const cases: [string, (source: string) => string, RegExp][] = [
    ['脚本', (source) => source.replace('</div>', '<script>alert(1)</script></div>'), /<script>/],
    [
      '事件属性',
      (source) => source.replace('<video id="clip-1"', '<video onloadstart="alert(1)" id="clip-1"'),
      /onloadstart/,
    ],
    ['根外面的标签', (source) => source.replace('</body>', '<iframe></iframe></body>'), /<iframe>/],
    ['注释', (source) => source.replace('</div>', '<!-- x --></div>'), /注释/],
    ['块之间的文字', (source) => source.replace('</div>', 'hello</div>'), /文字/],
    [
      '块里的子标签',
      (source) => source.replace('></video>', '><source src="x"></video>'),
      /<source>/,
    ],
    [
      '不是 http(s) 的地址',
      (source) => source.replaceAll('https://media.iclip.test/videos/b.mp4', 'javascript:alert(1)'),
      /地址/,
    ],
    [
      '没有声明的变量',
      (source) => source.replace(/ data-composition-variables="[^"]*"/, ''),
      /声明/,
    ],
    [
      '默认值和块上的地址不一样',
      (source) => source.replace('b.mp4&quot;', 'c.mp4&quot;'),
      /默认值/,
    ],
    [
      '多出来的变量',
      (source) =>
        source.replace(
          'data-composition-variables="[',
          'data-composition-variables="[{&quot;id&quot;:&quot;x&quot;,&quot;type&quot;:&quot;string&quot;,&quot;default&quot;:&quot;&quot;},',
        ),
      /没有块在用/,
    ],
    [
      '根上别的样式',
      (source) => source.replace('<div id="film"', '<div style="color:red" id="film"'),
      /样式/,
    ],
    ['带时间线脚本的根', (source) => source.replace(' data-no-timeline', ''), /data-no-timeline/],
  ]

  it.each(cases)('%s', (_name, tamper, message) => {
    const tampered = tamper(base)
    expect(tampered).not.toBe(base)
    expect(() => readFilm(tampered)).toThrow(FilmProblem)
    expect(() => readFilm(tampered)).toThrow(message)
  })

  it.each<[string, PictureBlock[], RegExp]>([
    ['同一行的两块重叠', [picture(), second({ start: 1500 })], /重叠/],
    ['超过两分钟', [picture({ duration: 120_001 })], /上限/],
    ['短于 100 毫秒', [picture({ duration: 99 })], /短于/],
    ['编号重复', [picture(), second({ id: 'clip-1' })], /重复/],
    ['音量超出范围', [picture({ volume: 4 })], /音量/],
    ['同一条素材片两个地址', [picture(), second({ jobId: SOURCE_JOB })], /两个地址|默认值/],
  ])('%s', (_name, blocks, message) => {
    expect(() => readFilm(html(...blocks))).toThrow(message)
  })

  it('SDK 在根上写的变量自定义属性可以带着，重写时不保留', async () => {
    const withStyle = base.replace(
      '<div id="film"',
      `<div style="--src-${SOURCE_JOB}: https://media.iclip.test/videos/a.mp4?sig=1&v=2" id="film"`,
    )
    expect((await checkFilm(withStyle, catalog)).html).toBe(base)
  })
})

describe('localizedFilm', () => {
  it('块上的地址和变量的默认值一起换成本地路径', () => {
    const local = localizedFilm(
      film(picture(), second()),
      { 'https://media.iclip.test/videos/b.mp4': 'media/b.mp4' },
      catalog,
    )
    expect(
      readFilm(local.replaceAll('media/b.mp4', 'https://local.test/media/b.mp4')).blocks,
    ).toEqual([picture(), second({ src: 'https://local.test/media/b.mp4' })])
    expect(local).not.toContain('https://media.iclip.test/videos/b.mp4')
  })
})
