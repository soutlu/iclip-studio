import { describe, expect, it } from 'vitest'
import { audio, caption, host, video } from '@/testing/final-cut'
import { isDubClip, type FilmClip } from './composition/film'
import {
  landingOn,
  musicRowTarget,
  rowHidden,
  namedRows,
  rowOpening,
  rowOpeningAmong,
  rowsOf,
  targetIn,
  topTrack,
  dubRowFor,
  originalRowFor,
  type Aim,
  type Row,
  type Zone,
} from './placement'

const first = video({ id: 'a', start: 0, duration: 2_000 })
const later = video({ id: 'b', start: 5_000, duration: 1_000 })
const below = video({ id: 'c', start: 1_000, duration: 1_000, track: 1 })
const clips = [first, later, below]

/** 画面区两行（组件一行、镜头一行），声音区两行；视频片段和音频片段都有第 0 行。 */
const title = host({ id: 't', start: 500, duration: 1_000, track: 0 })
const shot = video({ id: 'p', start: 0, duration: 3_000, track: 1 })
const music = audio({ id: 'm', start: 0, duration: 4_000, track: 0 })
const voice = audio({ id: 'v', start: 1_000, duration: 1_000, track: 1 })
const mixed = [voice, shot, music, title]
/** 一句字幕在语言 `locale` 下的配音片段，在声音区第 `track` 行。 */
const dubbed = (id: string, locale: string, track: number, start: number) =>
  audio({
    id,
    start,
    duration: 1_000,
    track,
    dub: { locale, caption: id, trimmed: false, text: null, voice: null, speed: 1 },
  })

const layout = (film: readonly FilmClip[]) =>
  rowsOf(film).map((row) => [row.zone, row.track, row.clips.map((clip) => clip.id)])

describe('时间线上的行', () => {
  it('按行分好片段：行号小的在前，行里按开始时间排', () => {
    expect(layout([later, below, first])).toEqual([
      ['visual', 0, ['a', 'b']],
      ['visual', 1, ['c']],
    ])
  })

  it('画面区在上、声音区在下，各按行号排；两个区的行号互不相干', () => {
    expect(layout(mixed)).toEqual([
      ['visual', 0, ['t']],
      ['visual', 1, ['p']],
      ['audio', 0, ['m']],
      ['audio', 1, ['v']],
    ])
  })

  it('主轨是画面区最上面那一行：音频片段的行号再小也不算', () => {
    expect(topTrack([shot, audio({ id: 'm', track: 0 })])).toBe(1)
    expect(topTrack(mixed)).toBe(0)
    expect(topTrack([music])).toBe(0)
  })

  it('一行隐藏着：只看这个区这一行的片段', () => {
    const muted = [{ ...music, hidden: true }, video({ id: 'q', track: 0 })]
    expect(rowHidden(muted, { zone: 'audio', track: 0 })).toBe(true)
    expect(rowHidden(muted, { zone: 'visual', track: 0 })).toBe(false)
    expect(rowHidden(muted, { zone: 'audio', track: 1 })).toBe(false)
  })
})

describe('行名', () => {
  const names = (rows: readonly Row[]) => namedRows(rows).map((row) => row.name)

  it('画面区一行、声音区一行：「画面 1」和「配乐」', () => {
    expect(names(rowsOf([first, music]))).toEqual(['画面 1', '配乐'])
  })

  it('画面区几行、声音区几行：各区从上往下编号，声音区的编号不接着画面区', () => {
    expect(names(rowsOf(mixed))).toEqual(['画面 1', '画面 2', '配乐 1', '配乐 2'])
  })

  it('行头的种类和编号：同种不止一行时才有编号，只有一行的「画面 1」不标', () => {
    const heads = (rows: readonly Row[]) =>
      namedRows(rows).map(({ kind, ordinal }) => ({ kind, ordinal }))
    expect(heads(rowsOf([first, music]))).toEqual([
      { kind: 'visual', ordinal: null },
      { kind: 'music', ordinal: null },
    ])
    expect(heads(rowsOf(mixed))).toEqual([
      { kind: 'visual', ordinal: 1 },
      { kind: 'visual', ordinal: 2 },
      { kind: 'music', ordinal: 1 },
      { kind: 'music', ordinal: 2 },
    ])
  })

  it('只有声音区：一行叫「配乐」', () => {
    expect(names(rowsOf([music]))).toEqual(['配乐'])
  })

  it('还没有片段时留着的那一条空行：「画面 1」', () => {
    expect(names([{ zone: 'visual', track: 0, clips: [] }])).toEqual(['画面 1'])
    expect(names([])).toEqual([])
  })

  it('全是分离出来的原声的行叫「原声」，全是配音片段的行叫「配音」，别的叫「配乐」；各自编号', () => {
    const spoken = (id: string, track: number) =>
      audio({ id, start: 0, duration: 1_000, track, link: 'lk-1', syncOrigin: 'lk-1' })
    expect(
      names(rowsOf([first, dubbed('en-1', 'en', 0, 0), spoken('v1', 1), { ...music, track: 2 }])),
    ).toEqual(['画面 1', '配音', '原声', '配乐'])
    expect(
      names(
        rowsOf([
          first,
          spoken('v1', 0),
          spoken('v2', 1),
          { ...music, track: 2 },
          { ...voice, track: 3 },
        ]),
      ),
    ).toEqual(['画面 1', '原声 1', '原声 2', '配乐 1', '配乐 2'])
    // 分离出来的原声和别的音频（含配音）混在一行：是配乐行
    expect(names(rowsOf([first, spoken('v1', 0), { ...voice, track: 0, start: 3_000 }]))).toEqual([
      '画面 1',
      '配乐',
    ])
    expect(names(rowsOf([first, spoken('v1', 0), dubbed('en-1', 'en', 0, 3_000)]))).toEqual([
      '画面 1',
      '配乐',
    ])
  })

  it('分离出来的原声放进第一条这段时间空着的原声行；都占着、或还没有原声行时在配音行下面（没有配音行就是声音区最上面）新开一行', () => {
    const spoken = (id: string, track: number, start: number) =>
      audio({ id, start, duration: 1_000, track, link: id, syncOrigin: id })
    const film = [
      first,
      spoken('v1', 0, 0),
      spoken('v2', 1, 2_000),
      { ...music, track: 2, start: 3_000 },
    ]
    const span = (start: number, duration: number) => ({ start, duration })
    // 第一条原声行 0–1 秒占着，第二条空着
    expect(originalRowFor(film, span(500, 1_000))).toEqual({ track: 1, renumber: new Map() })
    // 第一条原声行 2–3 秒空着
    expect(originalRowFor(film, span(2_000, 1_000))).toEqual({ track: 0, renumber: new Map() })
    // 两条原声行在 0.5–2.5 秒都占着：最上面新开一行，原来的声音行往下排一号
    expect(originalRowFor(film, span(500, 2_000))).toEqual({
      track: 0,
      renumber: new Map([
        ['v1', 1],
        ['v2', 2],
        ['m', 3],
      ]),
    })
    // 只有配乐行，空着也不进去：在它上面新开一行
    expect(originalRowFor([first, music], span(5_000, 1_000))).toEqual({
      track: 0,
      renumber: new Map([['m', 1]]),
    })
    // 还没有声音行：新开第一行
    expect(originalRowFor([first], span(0, 1_000))).toEqual({ track: 0, renumber: new Map() })
    // 有配音行：配音行空着也不进去，在它下面新开一行
    expect(
      originalRowFor(
        [first, dubbed('de-1', 'de', 0, 5_000), { ...music, track: 1 }],
        span(0, 1_000),
      ),
    ).toEqual({ track: 1, renumber: new Map([['m', 2]]) })
  })

  it('配音片段放进第一条这几段时间都空着的配音行，占没占着只看显示着的那种语言；没有时在声音区最上面新开一行', () => {
    const film = [
      first,
      dubbed('en-1', 'en', 0, 0),
      dubbed('de-1', 'de', 0, 2_000),
      { ...music, track: 1 },
    ]
    const english = (clip: FilmClip) => !isDubClip(clip) || clip.dub.locale === 'en'
    // 2–3 秒只有德语的配音：显示英语时这一行空着
    expect(dubRowFor(film, [{ start: 2_000, duration: 1_000 }], english)).toEqual({
      track: 0,
      renumber: new Map(),
    })
    // 0–1 秒有英语的配音：最上面新开一行，所有语言的配音一起往下排
    expect(dubRowFor(film, [{ start: 500, duration: 1_000 }], english)).toEqual({
      track: 0,
      renumber: new Map([
        ['en-1', 1],
        ['de-1', 1],
        ['m', 2],
      ]),
    })
    // 原声行、配乐行空着也不进去：在它们上面新开一行
    const spoken = audio({ id: 'v1', start: 5_000, duration: 1_000, track: 0, syncOrigin: 'v1' })
    expect(dubRowFor([first, spoken], [{ start: 0, duration: 1_000 }], english)).toEqual({
      track: 0,
      renumber: new Map([['v1', 1]]),
    })
  })

  it('别的语言的配音不显示时新开一行：没显示的配音行也跟着重新编号，不和新行、别的行撞号', () => {
    const source = (clip: FilmClip) => !isDubClip(clip)
    const english = (clip: FilmClip) => !isDubClip(clip) || clip.dub.locale === 'en'
    // 只有 English 的配音在声音区第 0 行：原文下在声音区最下面新开一行（加配乐），排在配音行后面
    expect(rowOpeningAmong([first, dubbed('en-1', 'en', 0, 0)], source, 'audio', 1)).toEqual({
      track: 1,
      renumber: new Map(),
    })
    // 配音第 0 行、配乐第 1 行：原文下在配乐上面新开一行，配音行不动、配乐往下排
    const film = [first, dubbed('en-1', 'en', 0, 0), { ...music, track: 1 }]
    expect(rowOpeningAmong(film, source, 'audio', 1)).toEqual({
      track: 1,
      renumber: new Map([['m', 2]]),
    })
    // English 下看得见配音行：在它上面新开一行，配音、配乐都往下排
    expect(rowOpeningAmong(film, english, 'audio', 1)).toEqual({
      track: 0,
      renumber: new Map([
        ['en-1', 1],
        ['m', 2],
      ]),
    })
  })

  it('配乐拖进声音区：对着原声行、配音行或在它们之间、上面新开一行时，改成在它们最后一条下面新开一行', () => {
    const spoken = (id: string, track: number) =>
      audio({ id, start: 0, duration: 1_000, track, syncOrigin: id })
    // 画面 1、配音、原声、配乐（时间线上第 0–3 行）
    const rows = rowsOf([
      first,
      dubbed('en-1', 'en', 0, 0),
      spoken('v2', 1),
      { ...music, track: 2 },
    ])
    const below = { zone: 'audio', insertAt: 3 } as const
    expect(musicRowTarget(rows, { zone: 'audio', track: 0 })).toEqual(below)
    expect(musicRowTarget(rows, { zone: 'audio', track: 1 })).toEqual(below)
    expect(musicRowTarget(rows, { zone: 'audio', insertAt: 1 })).toEqual(below)
    expect(musicRowTarget(rows, { zone: 'audio', insertAt: 2 })).toEqual(below)
    // 配乐行、配乐行下面、画面区：照原样
    expect(musicRowTarget(rows, { zone: 'audio', track: 2 })).toEqual({ zone: 'audio', track: 2 })
    expect(musicRowTarget(rows, { zone: 'audio', insertAt: 4 })).toEqual({
      zone: 'audio',
      insertAt: 4,
    })
    expect(musicRowTarget(rows, { zone: 'visual', track: 0 })).toEqual({
      zone: 'visual',
      track: 0,
    })
    // 没有原声行、配音行时不改
    expect(musicRowTarget(rowsOf([first, music]), { zone: 'audio', insertAt: 1 })).toEqual({
      zone: 'audio',
      insertAt: 1,
    })
  })

  it('行名跟着行走，行本身原样带着', () => {
    const [row] = namedRows(rowsOf([first]))
    expect(row).toEqual({
      zone: 'visual',
      track: 0,
      clips: [first],
      name: '画面 1',
      kind: 'visual',
      ordinal: null,
    })
  })
})

describe('落在一行的哪个时间', () => {
  it('指针在空处：就放在指针的位置', () => {
    expect(landingOn(clips, { zone: 'visual', track: 0 }, 2_500, 1_000)).toEqual({
      track: 0,
      start: 2_500,
    })
  })

  it('指针压在别的片段上：挪到最近的空位', () => {
    expect(landingOn(clips, { zone: 'visual', track: 0 }, 1_800, 1_000).start).toBe(2_000)
    expect(landingOn(clips, { zone: 'visual', track: 0 }, 4_600, 1_000).start).toBe(4_000)
  })

  it('空位不够长：接在这一行最后一个片段后面', () => {
    expect(landingOn(clips, { zone: 'visual', track: 0 }, 2_500, 4_000).start).toBe(6_000)
  })

  it('别的行、别的区同号的行上的片段不挡路', () => {
    expect(landingOn(clips, { zone: 'visual', track: 1 }, 0, 1_000).start).toBe(0)
    expect(landingOn(mixed, { zone: 'visual', track: 0 }, 0, 400).start).toBe(0)
    expect(landingOn(mixed, { zone: 'audio', track: 0 }, 0, 400).start).toBe(4_000)
  })
})

describe('片段只落在自己的区', () => {
  const rows = rowsOf(mixed)
  const aimed = (aim: Aim, zone: Zone) => targetIn(rows, aim, zone)

  it('对着自己的区的行：就是那一行', () => {
    expect(aimed({ at: 1 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ at: 3 }, 'audio')).toEqual({ zone: 'audio', track: 1 })
  })

  it('画面区的片段对着声音区的行：落在画面区最下面那一行；音频片段对着画面区的行：落在声音区最上面那一行', () => {
    expect(aimed({ at: 2 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ at: 3 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ at: 1 }, 'audio')).toEqual({ zone: 'audio', track: 0 })
  })

  it('两个区之间的缝：两种片段都能在那里新开一行', () => {
    expect(aimed({ insertAt: 2 }, 'visual')).toEqual({ zone: 'visual', insertAt: 2 })
    expect(aimed({ insertAt: 2 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
  })

  it('别的区里两行之间的缝：不新开，落在自己的区挨着的那一行', () => {
    expect(aimed({ insertAt: 3 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ insertAt: 1 }, 'audio')).toEqual({ zone: 'audio', track: 0 })
    expect(aimed({ insertAt: 1 }, 'visual')).toEqual({ zone: 'visual', insertAt: 1 })
    expect(aimed({ insertAt: 3 }, 'audio')).toEqual({ zone: 'audio', insertAt: 3 })
  })

  it('最下面那条空行：音频片段在那里新开一行；画面区的片段在画面区的最下面新开一行', () => {
    expect(aimed({ insertAt: 4 }, 'audio')).toEqual({ zone: 'audio', insertAt: 4 })
    expect(aimed({ insertAt: 4 }, 'visual')).toEqual({ zone: 'visual', insertAt: 2 })
  })

  it('最上面（指针在时间尺上也算）：画面区的片段在那里新开一行；音频片段在声音区的最上面新开一行', () => {
    expect(aimed({ insertAt: 0 }, 'visual')).toEqual({ zone: 'visual', insertAt: 0 })
    expect(aimed({ insertAt: 0 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
  })

  describe('有字幕时：画面 1、画面 2、字幕、配乐 1、配乐 2（时间线上第 0–4 行）', () => {
    const captioned = rowsOf([
      ...mixed,
      caption({ start: 0 }),
      caption({ id: 'cap-b2', start: 3_000 }),
    ])
    const at = (aim: Aim, zone: Zone) => targetIn(captioned, aim, zone)

    it('字幕那一行在画面区和声音区之间，叫「字幕」，一行里按开始时间排', () => {
      expect(layout([...mixed, caption({ id: 'cap-b2', start: 3_000 }), caption()])).toEqual([
        ['visual', 0, ['t']],
        ['visual', 1, ['p']],
        ['caption', 0, ['cap-a1', 'cap-b2']],
        ['audio', 0, ['m']],
        ['audio', 1, ['v']],
      ])
      expect(namedRows(captioned).map((row) => row.name)).toEqual([
        '画面 1',
        '画面 2',
        '字幕',
        '配乐 1',
        '配乐 2',
      ])
    })

    it('字幕对着哪里都留在字幕那一行，不新开行', () => {
      const own = { zone: 'caption', track: 0 }
      for (const aim of [
        { at: 0 },
        { at: 2 },
        { at: 4 },
        { insertAt: 0 },
        { insertAt: 2 },
        { insertAt: 3 },
        { insertAt: 5 },
      ])
        expect(at(aim, 'caption')).toEqual(own)
    })

    it('别的片段进不了字幕那一行：画面区的片段落在画面区最下面那一行，音频片段落在声音区最上面那一行', () => {
      expect(at({ at: 2 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
      expect(at({ at: 2 }, 'audio')).toEqual({ zone: 'audio', track: 0 })
    })

    it('字幕那一行上面的缝：画面区的片段在那里新开一行，音频片段落在声音区最上面那一行', () => {
      expect(at({ insertAt: 2 }, 'visual')).toEqual({ zone: 'visual', insertAt: 2 })
      expect(at({ insertAt: 2 }, 'audio')).toEqual({ zone: 'audio', track: 0 })
    })

    it('字幕那一行下面的缝：音频片段在那里新开一行，画面区的片段落在画面区最下面那一行', () => {
      expect(at({ insertAt: 3 }, 'audio')).toEqual({ zone: 'audio', insertAt: 3 })
      expect(at({ insertAt: 3 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    })

    it('新开一行按时间线上的第几行算，字幕那一行也算在里面', () => {
      expect(rowOpening([...mixed, caption()], 'visual', 2).track).toBe(2)
      expect(rowOpening([...mixed, caption()], 'audio', 3)).toEqual({
        track: 0,
        renumber: new Map([
          ['m', 1],
          ['v', 2],
        ]),
      })
    })
  })

  it('画面区还没有行：镜头对着声音区的行或最下面，都在最上面新开画面区的第一行', () => {
    const audioOnly = rowsOf([music, voice])
    expect(targetIn(audioOnly, { at: 1 }, 'visual')).toEqual({ zone: 'visual', insertAt: 0 })
    expect(targetIn(audioOnly, { insertAt: 2 }, 'visual')).toEqual({ zone: 'visual', insertAt: 0 })
  })

  it('声音区还没有行：画面区的片段哪里都能新开，音频片段对着画面区的行时在最下面新开声音区的第一行', () => {
    const visualOnly = rowsOf([title, shot])
    expect(targetIn(visualOnly, { insertAt: 2 }, 'visual')).toEqual({
      zone: 'visual',
      insertAt: 2,
    })
    expect(targetIn(visualOnly, { at: 0 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
    // 音频拖到画面行之间的缝、最下面那条空行，也是新开声音区的第一行
    expect(targetIn(visualOnly, { insertAt: 1 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
    expect(targetIn(visualOnly, { insertAt: 2 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
  })
})

describe('新开一行', () => {
  const opened = (film: FilmClip[], zone: Zone, insertAt: number, movedId?: string) => {
    const { track, renumber } = rowOpening(film, zone, insertAt, movedId)
    return { track, renumber: [...renumber] }
  }

  it('开在最上面：新的一行是 0 号，别的行都往后排一号', () => {
    expect(opened(clips, 'visual', 0)).toEqual({
      track: 0,
      renumber: [
        ['a', 1],
        ['b', 1],
        ['c', 2],
      ],
    })
  })

  it('开在两行之间：上面的行不动，下面的行往后排一号', () => {
    expect(opened(clips, 'visual', 1)).toEqual({ track: 1, renumber: [['c', 2]] })
  })

  it('开在最下面：别的行都不动', () => {
    expect(opened(clips, 'visual', 2)).toEqual({ track: 2, renumber: [] })
  })

  it('行号原来有空着的：顺带从 0 起连着排', () => {
    const gapped = [
      video({ id: 'a', track: 2 }),
      video({ id: 'b', track: 5 }),
      video({ id: 'c', track: 9 }),
    ]
    expect(opened(gapped, 'visual', 2)).toEqual({
      track: 2,
      renumber: [
        ['a', 0],
        ['b', 1],
        ['c', 3],
      ],
    })
  })

  it('只在同一个区里顺延：声音区开在两行之间，声音区下面的行往后排，画面区不动', () => {
    // 时间线上第 3 行的位置是声音区第 0 行和第 1 行之间
    expect(opened(mixed, 'audio', 3)).toEqual({ track: 1, renumber: [['v', 2]] })
    // 在两个区之间为声音区开：声音区的行都往后排一号
    expect(opened(mixed, 'audio', 2)).toEqual({
      track: 0,
      renumber: [
        ['m', 1],
        ['v', 2],
      ],
    })
    // 同一个位置为画面区开：是画面区最下面的新一行，声音区不动
    expect(opened(mixed, 'visual', 2)).toEqual({ track: 2, renumber: [] })
  })

  it('搬进新行的片段原来那一行只剩它：那一行不再算，位置按挪之前时间线上的第几行', () => {
    // c 自己占着第 2 行，搬到最上面：a、b 那一行排到 1 号，c 原来那一行空出来
    expect(opened(clips, 'visual', 0, 'c')).toEqual({
      track: 0,
      renumber: [
        ['a', 1],
        ['b', 1],
      ],
    })
    // 搬到自己这一行的上面或下面那道缝：还是原来的号，别的片段也不用动
    expect(opened(clips, 'visual', 1, 'c')).toEqual({ track: 1, renumber: [] })
    expect(opened(clips, 'visual', 2, 'c')).toEqual({ track: 1, renumber: [] })
    // 声音区独占一行的音频片段搬到自己上下的缝里也一样
    expect(opened(mixed, 'audio', 3, 'v')).toEqual({ track: 1, renumber: [] })
    expect(opened(mixed, 'audio', 4, 'v')).toEqual({ track: 1, renumber: [] })
  })

  it('搬进新行的片段原来那一行还有别的片段：那一行照常算', () => {
    expect(opened(clips, 'visual', 1, 'b')).toEqual({ track: 1, renumber: [['c', 2]] })
  })
})
