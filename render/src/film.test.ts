import { openComposition } from '@hyperframes/sdk'
import { describe, expect, it } from 'vitest'
import {
  AUDIO_SOURCE_LABEL,
  audioBlock,
  componentBlock,
  pictureBlock,
  sourceVariable,
  writeFilm,
  type Film,
  type FilmBlock,
  type PictureBlock,
} from '../../web/src/features/storyboard/whole-film/composition/film'
import { checkFilm, FilmProblem, localizedFilm, readFilm } from './film'
import { AUDIO_JOB, AUDIO_URL, audio, catalog, component, SOURCE_JOB } from './testing'

const OTHER_JOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const picture = (overrides: Partial<PictureBlock> = {}): PictureBlock => ({
  kind: 'picture',
  id: 'clip-1',
  label: '镜头 1',
  jobId: SOURCE_JOB,
  src: 'https://media.iclip.test/videos/a.mp4?sig=1&v=2',
  start: 0,
  duration: 2000,
  mediaStart: 500,
  track: 0,
  volume: 1,
  playbackRate: 1,
  fadeIn: 0,
  fadeOut: 0,
  muted: false,
  z: 0,
  hidden: false,
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

const film = (...blocks: FilmBlock[]): Film => ({ canvas: { width: 720, height: 1280 }, blocks })
const html = (...blocks: FilmBlock[]) => writeFilm(film(...blocks), catalog)

/** 一个三种片段都有的成片：视频片段、组件或块的片段和音频片段同是第 0 行，时间也重叠。 */
const titled = component({
  start: 500,
  duration: 1500,
  playbackStart: 1000,
  values: { text: '新品上市', accent: '#ff0000', weight: '700' },
  z: 2,
})
const music = audio({ duration: 5000, volume: 0.5, fadeIn: 1000, fadeOut: 500, loop: true })

describe('checkFilm', () => {
  it('写出来的成片读回来是同一份，重写后一字不差', async () => {
    const written = html(picture(), second())
    const checked = await checkFilm(written, catalog)
    expect(checked.film).toEqual(film(picture(), second()))
    expect(checked.html).toBe(written)
    expect(checked.durationMs).toBe(5000)
    expect(checked.sources).toEqual([
      { jobId: SOURCE_JOB, url: 'https://media.iclip.test/videos/a.mp4?sig=1&v=2', kind: 'video' },
      { jobId: OTHER_JOB, url: 'https://media.iclip.test/videos/b.mp4', kind: 'video' },
    ])
  })

  it('两行上同时出现的片段：行号和叠放顺序都读回来，重写后一字不差；叠放顺序是 0 时文件里不写', async () => {
    const below = picture({ track: 1 })
    const above = second({ start: 500, track: 0, z: 3 })
    const written = html(below, above)
    expect(written).toContain('<video style="z-index: 3" id="clip-2"')
    expect(written).toContain('<video id="clip-1"')
    const checked = await checkFilm(written, catalog)
    expect(checked.film).toEqual(film(below, above))
    expect(checked.html).toBe(written)
  })

  it('隐藏的片段：隐藏标记读回来，重写后一字不差，时长照算；没隐藏时文件里不写', async () => {
    const hidden = second({ hidden: true, z: 2 })
    const written = html(picture(), hidden)
    expect(written).toContain('<video data-hidden="" style="z-index: 2" id="clip-2"')
    expect(written).toContain('<video id="clip-1"')
    const checked = await checkFilm(written, catalog)
    expect(checked.film).toEqual(film(picture(), hidden))
    expect(checked.html).toBe(written)
    expect(checked.durationMs).toBe(5000)
  })

  it('还没有片段的成片也能通过', async () => {
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

  it('三种片段写出来读回来是同一份，重写后一字不差；视频片段和音频片段同是第 0 行也行；素材分视频和音频', async () => {
    const blocks = [picture(), second(), component({ ...titled, track: 1 }), music]
    const written = html(...blocks)
    const checked = await checkFilm(written, catalog)
    expect(checked.film).toEqual(film(...blocks))
    expect(checked.html).toBe(written)
    expect(checked.sources).toEqual([
      { jobId: SOURCE_JOB, url: 'https://media.iclip.test/videos/a.mp4?sig=1&v=2', kind: 'video' },
      { jobId: OTHER_JOB, url: 'https://media.iclip.test/videos/b.mp4', kind: 'video' },
      { jobId: AUDIO_JOB, url: AUDIO_URL, kind: 'audio' },
    ])
  })

  it('视频片段和音频片段绑同一条记录：算两个素材，一个视频一个音频', async () => {
    // 时间错开：同一个地址同时出声，渲染引擎自带的检查会拒收
    const same = audio({ jobId: SOURCE_JOB, src: picture().src, start: 2000 })
    const checked = await checkFilm(html(picture(), same), catalog)
    expect(checked.sources.map((source) => [source.jobId, source.kind])).toEqual([
      [SOURCE_JOB, 'video'],
      [SOURCE_JOB, 'audio'],
    ])
  })

  it('成片没有时长上限：三种片段的结尾都可以过 2 分钟', async () => {
    const long = [
      picture({ duration: 200_000 }),
      audio({ duration: 150_000 }),
      component({ start: 210_000 }),
    ]
    const checked = await checkFilm(html(...long), catalog)
    expect(checked.durationMs).toBeGreaterThan(210_000)
  })

  it('成片总长算到最晚结尾的片段，音频片段和组件或块的片段也算', async () => {
    expect((await checkFilm(html(picture(), audio({ duration: 6000 })), catalog)).durationMs).toBe(
      6000,
    )
    const late = component({ start: 3000, duration: 4000 })
    expect((await checkFilm(html(picture(), late), catalog)).durationMs).toBe(7000)
  })

  it('可选属性取默认值时不写：组件从头播、不淡入淡出、不循环、没隐藏、叠放顺序 0', async () => {
    const written = html(component(), audio())
    expect(written).toContain('<div id="title-1" data-hf-id="title-1" class="clip component"')
    expect(written).toContain('<audio id="music-1" data-hf-id="music-1" class="clip audio"')
    for (const name of ['data-playback-start', 'data-fade-in', 'data-fade-out', 'loop', 'style']) {
      expect(written).not.toContain(` ${name}=`)
    }
    const still = html(picture(), audio({ start: 2000 }))
    for (const name of ['data-playback-rate', 'data-fade-in', 'data-fade-out', 'muted']) {
      expect(still).not.toContain(` ${name}=`)
    }
    expect(still).toContain(' data-has-audio="true"')
    const shown = html(
      component({ playbackStart: 500, z: 1, hidden: true }),
      audio({ fadeIn: 200, fadeOut: 300, loop: true, hidden: true }),
    )
    expect(shown).toContain('<div data-hidden="" style="z-index: 1" id="title-1"')
    expect(shown).toContain(' data-playback-start="0.5"')
    expect(shown).toContain('<audio data-hidden="" id="music-1"')
    expect(shown).toContain(' data-fade-in="0.2" data-fade-out="0.3" loop="true"></audio>')
    expect((await checkFilm(shown, catalog)).html).toBe(shown)
  })

  it('视频片段的增益、速度、淡入淡出、静音，音频片段的速度：读回来是同一份，重写后一字不差，过渲染前的检查', async () => {
    const quiet = picture({
      volume: 3.981072,
      playbackRate: 0.25,
      fadeIn: 500,
      fadeOut: 1500,
      muted: true,
    })
    const fast = audio({ start: 2000, volume: 0.001, playbackRate: 10, fadeIn: 100 })
    const written = html(quiet, fast)
    expect(written).toMatch(/<video [^>]* data-playback-rate="0.25" [^>]*muted="true"/)
    expect(written).not.toContain('data-has-audio')
    expect(written).toContain(' data-volume="0.001" data-playback-rate="10" data-fade-in="0.1"')
    const checked = await checkFilm(written, catalog)
    expect(checked.film).toEqual(film(quiet, fast))
    expect(checked.html).toBe(written)
  })

  it('用 SDK 改视频片段的速度、淡入淡出和静音，改音频片段的循环（编辑器右侧栏）：存出来的文件通过检查，读回来是改完的样子', async () => {
    const stored = (await checkFilm(html(picture(), audio({ start: 2000 })), catalog)).html
    const session = await openComposition(stored)
    session.batch(() => {
      session.setAttribute('clip-1', 'data-playback-rate', '2')
      session.setAttribute('clip-1', 'data-fade-in', '0.5')
      session.setAttribute('clip-1', 'data-volume', '1.995262')
      session.setAttribute('clip-1', 'muted', 'true')
      session.setAttribute('clip-1', 'data-has-audio', null)
      session.setAttribute('music-1', 'loop', 'true')
      session.setAttribute('music-1', 'data-playback-rate', '0.5')
    })
    const checked = await checkFilm(session.serialize(), catalog)
    const changed = [
      picture({ playbackRate: 2, fadeIn: 500, volume: 1.995262, muted: true }),
      audio({ start: 2000, loop: true, playbackRate: 0.5 }),
    ]
    expect(checked.film).toEqual(film(...changed))
    expect(checked.html).toBe(html(...changed))
    session.undo()
    expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
  })

  it('音频地址也绑按记录编号取名的变量，变量的名字是「音频」', async () => {
    const written = html(audio())
    expect(written).toContain(` data-var-src="src-${AUDIO_JOB}"`)
    const declared = /data-composition-variables="([^"]*)"/.exec(written)?.[1] ?? ''
    expect(JSON.parse(declared.replaceAll('&quot;', '"'))).toEqual([
      sourceVariable(AUDIO_JOB, AUDIO_URL, AUDIO_SOURCE_LABEL),
    ])
  })

  it('用到带字体的条目：<head> 里链上它的字体，照样过渲染前的检查', async () => {
    const brand = component({
      component: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
    })
    const checked = await checkFilm(html(brand), catalog)
    expect(checked.html).toContain(
      '<link rel="stylesheet" href="vendor/fonts/families/playfair-display.css">',
    )
  })

  it('固定尺寸、带默认字体的组件放进不一样大的画面：缩放和字体变量写进 <head>，照样过渲染前的检查', async () => {
    const brand = component({
      component: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
    })
    const checked = await checkFilm(html(brand), catalog)
    expect(checked.html).toContain(
      "#film #title-1{left:50%;top:50%;width:1920px;height:1080px;translate:-50% -50%;scale:0.375;--font-display:'Playfair Display', 'Noto Sans SC', sans-serif;--font-body:'Playfair Display', 'Noto Sans SC', sans-serif}\n",
    )
  })

  it('SDK 存出来的文件 <head> 里没有组件的规则：重写时按片段补上', async () => {
    const session = await openComposition(html())
    session.addElement(
      'film',
      0,
      componentBlock(
        component({
          id: 'scene-1',
          component: 'fixture-scene',
          src: 'compositions/fixtures/fixture-scene.html',
        }),
      ),
    )
    const saved = session.serialize()
    expect(saved).not.toContain('#film #scene-1')
    expect((await checkFilm(saved, catalog)).html).toContain(
      '#film #scene-1{left:50%;top:50%;width:1920px;height:1080px;translate:-50% -50%;scale:0.375}\n',
    )
  })

  it('字体可填项填的不是组件库里的字体（哪怕带着标签）：不写进样式，照样过检查', async () => {
    const hostile = component({
      component: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
      values: { font: "x'}</style><script>alert(1)</script>" },
    })
    const checked = await checkFilm(html(hostile), catalog)
    expect(checked.html).not.toContain('<script')
    expect(checked.html).not.toContain('--font-display')
    expect(checked.html).toContain(
      '#film #title-1{left:50%;top:50%;width:1920px;height:1080px;translate:-50% -50%;scale:0.375}\n',
    )
  })

  it('用 SDK 加组件或块的片段和音频片段、改音频的起止，存出来的文件通过检查，读回来是改完的样子', async () => {
    const stored = (await checkFilm(html(picture()), catalog)).html
    const session = await openComposition(stored)
    const placed = component({ ...titled, track: 1 })
    session.batch(() => {
      session.addElement('film', 1, componentBlock(placed))
      session.declareVariable(sourceVariable(AUDIO_JOB, AUDIO_URL, AUDIO_SOURCE_LABEL))
      session.addElement('film', 2, audioBlock(music))
      session.dispatch({ type: 'setCompositionMetadata', duration: 5 })
    })
    session.batch(() => {
      session.setTiming('music-1', { start: 1, duration: 3 })
      session.dispatch({ type: 'setCompositionMetadata', duration: 4 })
    })
    const checked = await checkFilm(session.serialize(), catalog)
    const moved = { ...music, start: 1000, duration: 3000 }
    expect(checked.film).toEqual(film(picture(), placed, moved))
    expect(checked.durationMs).toBe(4000)
    expect(checked.html).toBe(html(picture(), placed, moved))
  })

  it('用 SDK 把组件或块的片段的可填项整串换掉（编辑器右侧栏改值），存出来的文件通过检查，读回来是新的取值', async () => {
    const placed = component({ ...titled, track: 1 })
    const stored = (await checkFilm(html(picture(), placed), catalog)).html
    const session = await openComposition(stored)
    const values = { ...titled.values, text: 'New title', size: 120, shadow: true }
    session.batch(() => {
      session.setAttribute('title-1', 'data-variable-values', JSON.stringify(values))
      session.dispatch({ type: 'setCompositionMetadata', duration: 2 })
    })
    const checked = await checkFilm(session.serialize(), catalog)
    const changed = { ...placed, values }
    expect(checked.film).toEqual(film(picture(), changed))
    expect(checked.html).toBe(html(picture(), changed))
  })

  it('用 SDK 加片段、存出来的文件通过检查，重写后 SDK 再开再存仍然通过且内容不变', async () => {
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

  describe('编辑器加素材、撤销、重做后存出来的文件', () => {
    type Session = Awaited<ReturnType<typeof openComposition>>

    /** 和编辑器加素材时发的操作一样：没声明过的素材先声明变量，再把片段写在根下第一个、改总时长。 */
    const add = (session: Session, block: PictureBlock) => {
      const declared = session.listVariables().map((variable) => variable.id)
      const variable = sourceVariable(block.jobId, block.src)
      session.batch(() => {
        if (!declared.includes(variable.id)) session.declareVariable(variable)
        session.addElement('film', 0, pictureBlock(block))
        session.dispatch({
          type: 'setCompositionMetadata',
          duration: (block.start + block.duration) / 1000,
        })
      })
    }

    it('从空成片加第一条素材再撤销：回到没有片段的成片；重做后素材回来', async () => {
      const session = await openComposition(html())
      add(session, picture({ z: 1 }))
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).film.blocks).toEqual([])
      session.redo()
      expect((await checkFilm(session.serialize(), catalog)).film).toEqual(film(picture({ z: 1 })))
    })

    it('打开存着的成片，加一条新素材再撤销：和存着的一样；重做后新的一条写在最前面', async () => {
      const stored = (await checkFilm(html(picture()), catalog)).html
      const session = await openComposition(stored)
      add(session, second({ z: 2 }))
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
      session.redo()
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(film(second({ z: 2 }), picture()))
      expect(checked.html).toBe(html(second({ z: 2 }), picture()))
    })

    it('同一条素材加两次再撤销一次：变量还在，剩下的那一个片段照样通过', async () => {
      const session = await openComposition(html())
      add(session, picture({ z: 1 }))
      add(session, picture({ id: 'clip-2', start: 2000, mediaStart: 3000, z: 2 }))
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).film).toEqual(film(picture({ z: 1 })))
    })
  })

  describe('编辑器挪动、裁剪、删除后存出来的文件', () => {
    type Session = Awaited<ReturnType<typeof openComposition>>

    /** 和编辑器改一个片段时发的操作一样：起止、入点和成片总长算一步。 */
    const retime = (
      session: Session,
      id: string,
      timing: Pick<PictureBlock, 'start' | 'duration' | 'mediaStart'>,
      total: number,
    ) =>
      session.batch(() => {
        session.setTiming(id, { start: timing.start / 1000, duration: timing.duration / 1000 })
        session.setAttribute(id, 'data-media-start', String(timing.mediaStart / 1000))
        session.dispatch({ type: 'setCompositionMetadata', duration: total / 1000 })
      })

    it('裁开头再挪走：起止和入点都按新的读回来，成片总长跟着变；撤销回到原样', async () => {
      const stored = (await checkFilm(html(picture(), second()), catalog)).html
      const session = await openComposition(stored)
      const moved = { start: 2600, duration: 2400, mediaStart: 1600 }
      retime(session, 'clip-2', moved, 5000)
      const later = { ...moved, start: 4000 }
      retime(session, 'clip-2', later, 6400)
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(film(picture(), second(later)))
      expect(checked.durationMs).toBe(6400)
      session.undo()
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })

    it('删掉一个片段、后面的往前补，用不到的素材变量一起去掉；撤销后两个片段和变量都回来', async () => {
      const stored = (await checkFilm(html(picture(), second()), catalog)).html
      const session = await openComposition(stored)
      session.batch(() => {
        session.removeElement('clip-1')
        session.setTiming('clip-2', { start: 0 })
        session.removeVariableDeclaration(sourceVariable(SOURCE_JOB, picture().src).id)
        session.dispatch({ type: 'setCompositionMetadata', duration: 3 })
      })
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(film(second({ start: 0 })))
      expect(checked.sources.map((source) => source.jobId)).toEqual([OTHER_JOB])
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })

    /** 和编辑器换行时发的操作一样：改行号和起点、需要时改它的叠放顺序（0 时去掉样式），和成片总长算一步。 */
    const changeRow = (
      session: Session,
      id: string,
      at: Pick<PictureBlock, 'start' | 'track'>,
      z: number | undefined,
      total: number,
    ) =>
      session.batch(() => {
        session.setTiming(id, { start: at.start / 1000, trackIndex: at.track })
        if (z !== undefined) session.setStyle(id, { zIndex: z > 0 ? String(z) : null })
        session.dispatch({ type: 'setCompositionMetadata', duration: total / 1000 })
      })

    it('把片段换到上面一行、调高叠放顺序：读回来是新的行号、起点和叠放顺序，文件里的先后不变；撤销回到原样', async () => {
      const stored = (await checkFilm(html(second({ track: 2 }), picture({ track: 1 })), catalog))
        .html
      const session = await openComposition(stored)
      changeRow(session, 'clip-2', { start: 500, track: 0 }, 3, 3500)
      const moved = second({ start: 500, track: 0, z: 3 })
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(film(moved, picture({ track: 1 })))
      expect(checked.html).toBe(html(moved, picture({ track: 1 })))
      expect(checked.durationMs).toBe(3500)
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })

    it('把片段换到下面一行、叠放顺序降到 0：片段上不再带样式，重写后一字不差；撤销回到原样', async () => {
      const stored = (await checkFilm(html(second({ z: 2 }), picture({ z: 1 })), catalog)).html
      const session = await openComposition(stored)
      changeRow(session, 'clip-2', { start: 500, track: 1 }, 0, 3500)
      const saved = session.serialize()
      expect(saved).toContain('<video id="clip-2"')
      const checked = await checkFilm(saved, catalog)
      expect(checked.film).toEqual(film(second({ start: 500, track: 1 }), picture({ z: 1 })))
      expect(checked.html).toBe(html(second({ start: 500, track: 1 }), picture({ z: 1 })))
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })

    it('SDK 自己的调叠放顺序和换行操作存出来的文件也认', async () => {
      const session = await openComposition(html(picture(), second()))
      session.batch(() => {
        session.setTiming('clip-2', { start: 0.5, trackIndex: 1 })
        session.dispatch({ type: 'reorderElements', entries: [{ target: 'clip-2', zIndex: 2 }] })
        session.dispatch({ type: 'setCompositionMetadata', duration: 3.5 })
      })
      expect((await checkFilm(session.serialize(), catalog)).film).toEqual(
        film(picture(), second({ start: 500, track: 1, z: 2 })),
      )
    })

    it('把片段搬进最上面新开的一行（别的片段先改行号，再改它的行号、起点和叠放顺序）：读回来是新的行号，文件里的先后不变；撤销回到原样', async () => {
      const stored = (await checkFilm(html(picture(), second()), catalog)).html
      const session = await openComposition(stored)
      session.batch(() => {
        session.setTiming('clip-1', { trackIndex: 1 })
        session.setTiming('clip-2', { start: 0.5, trackIndex: 0 })
        session.setStyle('clip-2', { zIndex: '1' })
        session.dispatch({ type: 'setCompositionMetadata', duration: 3.5 })
      })
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(
        film(picture({ track: 1 }), second({ start: 500, track: 0, z: 1 })),
      )
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })

    it('成组挪动、被抓的片段搬进最上面新开的一行（别的片段先改行号，跟着的片段挪好起点，再改它自己）：读回来是新的行号和时间；撤销回到原样', async () => {
      const third = picture({ id: 'clip-3', start: 5000, duration: 1000 })
      const stored = (await checkFilm(html(picture(), second(), third), catalog)).html
      const session = await openComposition(stored)
      // clip-2 搬到最上面新开的一行、往后挪 0.5 秒；选中的 clip-1 跟着挪 0.5 秒，留在原来那一行
      session.batch(() => {
        session.setTiming('clip-1', { trackIndex: 1 })
        session.setTiming('clip-3', { trackIndex: 1 })
        session.setTiming('clip-1', { start: 0.5 })
        session.setTiming('clip-2', { start: 2.5, trackIndex: 0 })
        session.dispatch({ type: 'setCompositionMetadata', duration: 6 })
      })
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(
        film(
          picture({ start: 500, track: 1 }),
          second({ start: 2500, track: 0 }),
          picture({ ...third, track: 1 }),
        ),
      )
      expect(checked.durationMs).toBe(6000)
      session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })

    it('隐藏一个片段再显示回来（SDK 加、去隐藏标记）：隐藏时读回来带着标记，显示回来和原来一字不差', async () => {
      const stored = (await checkFilm(html(picture(), second()), catalog)).html
      const session = await openComposition(stored)
      session.setAttribute('clip-2', 'data-hidden', '')
      expect((await checkFilm(session.serialize(), catalog)).film).toEqual(
        film(picture(), second({ hidden: true })),
      )
      session.setAttribute('clip-2', 'data-hidden', null)
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })

    it('把片段全删掉：剩下一份没有画面的成片，照样通过', async () => {
      const session = await openComposition(html(picture()))
      session.batch(() => {
        session.removeElement('clip-1')
        session.removeVariableDeclaration(sourceVariable(SOURCE_JOB, picture().src).id)
        session.dispatch({ type: 'setCompositionMetadata', duration: 0 })
      })
      expect((await checkFilm(session.serialize(), catalog)).film.blocks).toEqual([])
    })

    it('组件或块的片段裁开头（SDK 改起止、加从第几秒开始播）：存出来的文件通过检查，读回来带着它；拉回 0 去掉这个属性，和原来一字不差', async () => {
      const stored = (await checkFilm(html(picture({ track: 1 }), component()), catalog)).html
      const session = await openComposition(stored)
      // 和编辑器裁开头时发的操作一样：起止和从第几秒开始播在同一批里改
      session.batch(() => {
        session.setTiming('title-1', { start: 0.5, duration: 1.5 })
        session.setAttribute('title-1', 'data-playback-start', '0.5')
        session.dispatch({ type: 'setCompositionMetadata', duration: 2 })
      })
      const trimmed = component({ start: 500, duration: 1500, playbackStart: 500 })
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(film(picture({ track: 1 }), trimmed))
      expect(checked.html).toBe(html(picture({ track: 1 }), trimmed))

      session.batch(() => {
        session.setTiming('title-1', { start: 0, duration: 2 })
        session.setAttribute('title-1', 'data-playback-start', null)
        session.dispatch({ type: 'setCompositionMetadata', duration: 2 })
      })
      const restored = await checkFilm(session.serialize(), catalog)
      expect(restored.html).toBe(stored)
      expect(session.serialize()).not.toContain('data-playback-start')
    })

    it('加组件或块的片段、加音频片段（都写在根下第一个）、在行里挪、换行、隐藏：存出来的文件通过检查，读回来是改完的样子；撤销一步步回去', async () => {
      const stored = (await checkFilm(html(picture({ z: 1 })), catalog)).html
      const session = await openComposition(stored)
      const steps: string[] = [stored]
      const step = (change: () => void) => {
        session.batch(change)
        steps.push(session.serialize())
      }
      // 和编辑器加片段时发的操作一样：组件或块的片段叠在最上面；音频片段先声明变量，不带叠放顺序
      step(() => {
        session.addElement('film', 0, componentBlock(component({ start: 500, track: 1, z: 2 })))
        session.dispatch({ type: 'setCompositionMetadata', duration: 2.5 })
      })
      step(() => {
        session.declareVariable(sourceVariable(AUDIO_JOB, AUDIO_URL, AUDIO_SOURCE_LABEL))
        session.addElement('film', 0, audioBlock(audio({ duration: 3000 })))
        session.dispatch({ type: 'setCompositionMetadata', duration: 3 })
      })
      // 在行里挪：组件或块的片段只改起止，音频片段连入点一起改
      step(() => {
        session.setTiming('title-1', { start: 0.2, duration: 1.8 })
        session.setTiming('music-1', { start: 0.5, duration: 2.5 })
        session.setAttribute('music-1', 'data-media-start', '0.5')
        session.dispatch({ type: 'setCompositionMetadata', duration: 3 })
      })
      // 换行：组件或块的片段换到视频片段那一行、接在它后面，降叠放顺序；音频片段换到声音区的另一行
      step(() => {
        session.setTiming('title-1', { start: 2, trackIndex: 0 })
        session.setStyle('title-1', { zIndex: '1' })
        session.setTiming('music-1', { start: 0.5, trackIndex: 1 })
        session.dispatch({ type: 'setCompositionMetadata', duration: 3.8 })
      })
      step(() => {
        session.setAttribute('title-1', 'data-hidden', '')
        session.setAttribute('music-1', 'data-hidden', '')
        session.dispatch({ type: 'setCompositionMetadata', duration: 3.8 })
      })
      const expected = [
        audio({ start: 500, duration: 2500, mediaStart: 500, track: 1, hidden: true }),
        component({ start: 2000, duration: 1800, z: 1, hidden: true }),
        picture({ z: 1 }),
      ]
      const checked = await checkFilm(session.serialize(), catalog)
      expect(checked.film).toEqual(film(...expected))
      expect(checked.html).toBe(html(...expected))
      expect(checked.durationMs).toBe(3800)
      // 每一步存出来的文件都通过检查；撤销到底回到存着的那一份
      for (const saved of steps) await checkFilm(saved, catalog)
      while (session.canUndo()) session.undo()
      expect((await checkFilm(session.serialize(), catalog)).html).toBe(stored)
    })
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
    ['片段之间的文字', (source) => source.replace('</div>', 'hello</div>'), /文字/],
    [
      '片段里的子标签',
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
      '默认值和片段上的地址不一样',
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
      /没有片段在用/,
    ],
    [
      '根上别的样式',
      (source) => source.replace('<div id="film"', '<div style="color:red" id="film"'),
      /样式/,
    ],
    [
      '片段上叠放顺序之外的样式',
      (source) =>
        source.replace('<video id="clip-1"', '<video style="position: fixed" id="clip-1"'),
      /叠放顺序/,
    ],
    [
      '片段上叠放顺序后面还跟着别的样式',
      (source) =>
        source.replace('<video id="clip-1"', '<video style="z-index: 2; opacity: 0" id="clip-1"'),
      /叠放顺序/,
    ],
    [
      '叠放顺序太大',
      (source) => source.replace('<video id="clip-1"', '<video style="z-index: 10000" id="clip-1"'),
      /叠放顺序/,
    ],
    [
      '隐藏标记带了值',
      (source) => source.replace('<video id="clip-1"', '<video data-hidden="false" id="clip-1"'),
      /data-hidden/,
    ],
    ['带时间线脚本的根', (source) => source.replace(' data-no-timeline', ''), /data-no-timeline/],
  ]

  it.each(cases)('%s', (_name, tamper, message) => {
    const tampered = tamper(base)
    expect(tampered).not.toBe(base)
    expect(() => readFilm(tampered, catalog)).toThrow(FilmProblem)
    expect(() => readFilm(tampered, catalog)).toThrow(message)
  })

  const mixed = html(picture(), component({ ...titled, track: 1 }), music)
  const mixedCases: [string, (source: string) => string, RegExp][] = [
    [
      '可填项取值不是 JSON 对象',
      (source) => source.replace(/data-variable-values="[^"]*"/, 'data-variable-values="[1]"'),
      /JSON 对象/,
    ],
    [
      '可填项取值里有对象',
      (source) =>
        source.replace(
          /data-variable-values="[^"]*"/,
          'data-variable-values="{&quot;text&quot;:{&quot;a&quot;:1}}"',
        ),
      /JSON 对象/,
    ],
    [
      '可填项取值不是 JSON',
      (source) => source.replace(/data-variable-values="[^"]*"/, 'data-variable-values="{oops"'),
      /JSON 对象/,
    ],
    ['循环写了 true 以外的值', (source) => source.replace('loop="true"', 'loop=""'), /loop/],
    [
      '视频片段同时带静音和有声音的标记',
      (source) => source.replace(' data-has-audio="true"', ' data-has-audio="true" muted="true"'),
      /不能同时带 muted 和 data-has-audio/,
    ],
    [
      '静音写了 true 以外的值',
      (source) => source.replace(' data-has-audio="true"', ' muted=""'),
      /muted/,
    ],
    [
      '速度不是数字',
      (source) => source.replace(' data-volume="1"', ' data-volume="1" data-playback-rate="2x"'),
      /速度/,
    ],
    [
      '音频片段带静音（导出不认）',
      (source) => source.replace('<audio id="music-1"', '<audio muted="true" id="music-1"'),
      /不能带 muted/,
    ],
    [
      '片段上带对象自带的属性名',
      (source) => source.replace('<video id="clip-1"', '<video constructor="x" id="clip-1"'),
      /不能带 constructor/,
    ],
    [
      '片段上带 __proto__',
      (source) => source.replace('<audio id="music-1"', '<audio __proto__="x" id="music-1"'),
      /不能带 __proto__/,
    ],
    [
      '音频片段带样式',
      (source) => source.replace('<audio id="music-1"', '<audio style="z-index: 1" id="music-1"'),
      /不能带 style/,
    ],
    ['淡入不是秒数', (source) => source.replace('data-fade-in="1"', 'data-fade-in="1s"'), /淡入/],
    [
      '组件或块的片段缺可填项取值',
      (source) => source.replace(/ data-variable-values="[^"]*"/, ''),
      /缺少 data-variable-values/,
    ],
    [
      '组件或块的片段里有子标签',
      (source) => source.replace('></div>\n<audio', '><span></span></div>\n<audio'),
      /<span>/,
    ],
  ]

  it.each(mixedCases)('%s', (_name, tamper, message) => {
    const tampered = tamper(mixed)
    expect(tampered).not.toBe(mixed)
    expect(() => readFilm(tampered, catalog)).toThrow(FilmProblem)
    expect(() => readFilm(tampered, catalog)).toThrow(message)
  })

  it.each<[string, FilmBlock[], RegExp]>([
    ['同一行的两个片段重叠', [picture(), second({ start: 1500 })], /重叠/],
    ['画面区同一行上视频片段和组件或块的片段重叠', [picture(), component({ start: 1000 })], /重叠/],
    ['声音区同一行上两个音频片段重叠', [audio(), audio({ id: 'music-2', start: 1500 })], /重叠/],
    ['短于 100 毫秒', [picture({ duration: 99 })], /短于/],
    ['音频短于 100 毫秒', [audio({ duration: 99 })], /短于/],
    ['编号重复', [picture(), second({ id: 'clip-1' })], /重复/],
    ['不同种的片段编号重复', [picture(), audio({ id: 'clip-1' })], /重复/],
    ['音量超出范围', [picture({ volume: 4 })], /音量/],
    ['音频音量超出范围', [audio({ volume: 4 })], /音量/],
    ['视频片段速度低于 0.1 倍', [picture({ playbackRate: 0.05 })], /速度/],
    ['视频片段速度高于 10 倍', [picture({ playbackRate: 10.5 })], /速度/],
    ['音频片段速度高于 10 倍', [audio({ playbackRate: 12 })], /速度/],
    ['同一条素材片两个地址', [picture(), second({ jobId: SOURCE_JOB })], /两个地址|默认值/],
    ['不在组件库里的组件', [component({ component: 'nope' })], /不在组件库/],
    [
      '组件名和组件库里的文件对不上',
      [component({ src: 'compositions/fixtures/fixture-overlay.html' })],
      /不在组件库/,
    ],
  ])('%s', (_name, blocks, message) => {
    expect(() => readFilm(html(...blocks), catalog)).toThrow(message)
  })

  it.each<[string, FilmBlock[]]>([
    ['视频片段和音频片段同是第 0 行、时间重叠', [picture(), audio()]],
    ['组件或块的片段和音频片段同是第 0 行、时间重叠', [component(), audio()]],
    ['视频片段和组件或块的片段在画面区的两行上', [picture(), component({ track: 1 })]],
  ])('%s：能过', (_name, blocks) => {
    expect(readFilm(html(...blocks), catalog).blocks).toEqual(blocks)
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
  it('片段上的地址和变量的默认值一起换成本地路径', () => {
    const local = localizedFilm(
      film(picture(), second()),
      { 'https://media.iclip.test/videos/b.mp4': 'media/b.mp4' },
      catalog,
    )
    expect(
      readFilm(local.replaceAll('media/b.mp4', 'https://local.test/media/b.mp4'), catalog).blocks,
    ).toEqual([picture(), second({ src: 'https://local.test/media/b.mp4' })])
    expect(local).not.toContain('https://media.iclip.test/videos/b.mp4')
  })

  it('音频片段的地址也换成本地路径，组件或块的片段不动', () => {
    const titledAbove = component({ ...titled, track: 1 })
    const local = localizedFilm(
      film(picture(), titledAbove, music),
      { [AUDIO_URL]: 'media/music.mp3' },
      catalog,
    )
    expect(local).not.toContain(AUDIO_URL)
    expect(
      readFilm(local.replaceAll('media/music.mp3', 'https://local.test/music.mp3'), catalog).blocks,
    ).toEqual([picture(), titledAbove, { ...music, src: 'https://local.test/music.mp3' }])
  })
})
