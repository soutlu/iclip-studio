import { describe, expect, it } from 'vitest'
import type { Clip } from '../editing/clip'
import { commit, redo, startHistory, undo } from '../editing/edit-history'
import {
  canSplitAt,
  EMPTY_FILM,
  filmDuration,
  insertBlockedReason,
  insertClockOf,
  insertIndexAt,
  insertSegment,
  keepKnownSources,
  MIN_SEGMENT_SECONDS,
  moveMusic,
  moveSegment,
  parseStoredFilm as parseDraft,
  putLane,
  removeSegment,
  serializeStoredFilm,
  setMusic,
  setMusicVolume,
  setSegmentVolume,
  resetMusicStart,
  setFont,
  setSentenceText,
  splitAt,
  trimBounds,
  trimSegment,
  type FilmMusic,
  type FilmSegment,
  type FilmState,
} from './film-draft'
import { MAX_FILM_SECONDS, MAX_FILM_SEGMENTS } from './film-limits'

const parseStoredFilm = (raw: string) => parseDraft(raw, (jobId) => jobId)

const pick = (sourceJobId: string, start: number, end: number): Clip => ({
  sourceJobId,
  start,
  end,
})

const film = (): FilmState => {
  let state = EMPTY_FILM
  for (const [id, part] of [
    ['s1', pick('A', 0, 3)],
    ['s2', pick('B', 1, 3)],
    ['s3', pick('A', 5, 6)],
  ] as const) {
    const next = insertSegment(state, part, state.segments.length, id)
    if (next === undefined) throw new Error('插不进去')
    state = next
  }
  return state
}

const order = (state: FilmState) =>
  state.segments.map((segment) => [segment.id, segment.sourceJobId, segment.start, segment.end])

describe('插入', () => {
  it('插在第几段之前，后面的段顺延，段之间没有空隙', () => {
    const next = insertSegment(film(), pick('C', 2, 4), 1, 'new')

    expect(order(next ?? EMPTY_FILM)).toEqual([
      ['s1', 'A', 0, 3],
      ['new', 'C', 2, 4],
      ['s2', 'B', 1, 3],
      ['s3', 'A', 5, 6],
    ])
    expect(filmDuration(next?.segments ?? [])).toBe(8)
    expect(insertClockOf(next?.segments ?? [], 2)).toBe(5)
  })

  it('同一截素材可以放进来几次，各是一段', () => {
    const once = insertSegment(EMPTY_FILM, pick('A', 0, 1), 0, 'a')
    const twice = once === undefined ? undefined : insertSegment(once, pick('A', 0, 1), 1, 'b')

    expect(twice?.segments.map((segment) => segment.id)).toEqual(['a', 'b'])
  })

  it.each([
    ['落在一段前一半，插在它前面', 1.4, 0],
    ['落在一段后一半，插在它后面', 1.6, 1],
    ['落在第二段后一半', 4.5, 2],
    ['末尾之后', 99, 3],
  ])('%s', (_, clock, index) => {
    expect(insertIndexAt(film().segments, clock)).toBe(index)
  })

  it(`整片最长 ${MAX_FILM_SECONDS} 秒：正好放满可以，多一点就不插`, () => {
    const full = insertSegment(EMPTY_FILM, pick('A', 0, MAX_FILM_SECONDS - 6), 0, 'big')
    const base = full === undefined ? EMPTY_FILM : full

    expect(insertSegment(base, pick('B', 0, 6), 1, 'fit')).toBeDefined()
    expect(insertSegment(base, pick('B', 0, 6.001), 1, 'over')).toBeUndefined()
  })

  it('不足最短时长的选区不插', () => {
    expect(insertSegment(EMPTY_FILM, pick('A', 1, 1.1), 0, 'tiny')).toBeUndefined()
  })
})

describe('插入校验', () => {
  const segments = (count: number, seconds = 1): FilmSegment[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `s${index}`,
      sourceJobId: 'A',
      start: 0,
      end: seconds,
    }))

  it('正好最短时长可以加入，短 1 毫秒就被阻止并说明原因', () => {
    expect(insertBlockedReason([], MIN_SEGMENT_SECONDS, 0)).toBeUndefined()
    expect(insertBlockedReason([], MIN_SEGMENT_SECONDS - 0.001, 0)).toMatch(
      /^镜头不足 0\.2 秒，无法加入成片；请/,
    )
  })

  it('段数到上限时阻止，少一段时可以加入', () => {
    expect(insertBlockedReason(segments(MAX_FILM_SEGMENTS - 1), 0.2, 0)).toBeUndefined()
    expect(insertBlockedReason(segments(MAX_FILM_SEGMENTS), 0.2, 0)).toMatch(
      /^片段已达 100 段，无法加入成片；请/,
    )
  })

  it('整片含片头片尾正好放满可以加入，多 1 毫秒就被阻止并说出已有时长', () => {
    expect(insertBlockedReason(segments(1, 100), 15, 5)).toBeUndefined()
    expect(insertBlockedReason(segments(1, 100), 15.001, 5)).toMatch(
      /^整片含片头片尾已有 105\.0 秒，.*无法加入成片；请/,
    )
  })

  it('与插入本身判定一致：被阻止时 insertSegment 不插', () => {
    const film = { ...EMPTY_FILM, segments: segments(MAX_FILM_SEGMENTS) }
    expect(insertSegment(film, pick('A', 0, 1), 0, 'extra')).toBeUndefined()
  })
})

describe('成片轨上的剪辑', () => {
  it('挪到第几段之前；挪回原处等于没挪', () => {
    expect(order(moveSegment(film(), 's3', 0) ?? EMPTY_FILM).map(([id]) => id)).toEqual([
      's3',
      's1',
      's2',
    ])
    expect(order(moveSegment(film(), 's1', 3) ?? EMPTY_FILM).map(([id]) => id)).toEqual([
      's2',
      's3',
      's1',
    ])
    expect(moveSegment(film(), 's2', 1)).toBeUndefined()
    expect(moveSegment(film(), 's2', 2)).toBeUndefined()
  })

  it('已知来源时长时可跨过初始选区扩展，不短于最短时长', () => {
    const trimmed = trimSegment(film(), 's1', 'start', 1)
    expect(order(trimmed)[0]).toEqual(['s1', 'A', 1, 3])

    expect(order(trimSegment(trimmed, 's1', 'start', -5))[0]).toEqual(['s1', 'A', 0, 3])
    expect(order(trimSegment(trimmed, 's1', 'end', 9, 8))[0]).toEqual(['s1', 'A', 1, 8])
    expect(order(trimSegment(trimmed, 's1', 'end', 1))[0]).toEqual(['s1', 'A', 1, 1.2])
  })

  it('裁剪拉长也不让整片超过上限', () => {
    const full = insertSegment(EMPTY_FILM, pick('A', 0, 100), 0, 'big')
    const trimmed = full === undefined ? EMPTY_FILM : trimSegment(full, 'big', 'end', 90)
    const plus = insertSegment(trimmed, pick('B', 0, 25), 1, 'b') ?? EMPTY_FILM
    const big = plus.segments[0]

    expect(filmDuration(plus.segments)).toBe(115)
    expect(big === undefined ? undefined : trimBounds(plus.segments, big, 'end', 0, 100)?.max).toBe(
      95,
    )
  })

  it('初始关键帧选区及拆分片段都可独立向前后扩展，精确到毫秒', () => {
    const initial = insertSegment(EMPTY_FILM, pick('A', 2, 5), 0, 'shot') ?? EMPTY_FILM
    const extended = trimSegment(
      trimSegment(initial, 'shot', 'start', 1.6004, 8),
      'shot',
      'end',
      5.4004,
      8,
    )
    expect(order(extended)).toEqual([['shot', 'A', 1.6, 5.4]])
    const split = splitAt(initial, 1, 'right') ?? EMPTY_FILM
    const changed = trimSegment(split, 'shot', 'end', 4, 8)
    expect(order(changed)).toEqual([
      ['shot', 'A', 2, 4],
      ['right', 'A', 3, 5],
    ])
    expect(order(trimSegment(changed, 'right', 'start', 0, 8))).toEqual([
      ['shot', 'A', 2, 4],
      ['right', 'A', 0, 5],
    ])
  })

  it('未读取来源时长时不允许猜测可扩展的结尾', () => {
    const initial = insertSegment(EMPTY_FILM, pick('A', 2, 5), 0, 'shot') ?? EMPTY_FILM
    expect(trimSegment(initial, 'shot', 'end', 7)).toBe(initial)
    expect(order(trimSegment(initial, 'shot', 'start', 1))).toEqual([['shot', 'A', 1, 5]])
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1, 4.999])(
    '来源时长 %s 无效或短于当前选区时拒绝裁剪，保留可恢复草稿',
    (sourceDuration) => {
      const initial = insertSegment(EMPTY_FILM, pick('A', 2, 5), 0, 'shot') ?? EMPTY_FILM
      const segment = initial.segments[0]
      expect(segment).toBeDefined()
      if (segment === undefined) return
      for (const edge of ['start', 'end'] as const) {
        expect(trimBounds(initial.segments, segment, edge, 0, sourceDuration)).toBeUndefined()
        const next = trimSegment(initial, 'shot', edge, 3, sourceDuration)
        expect(next).toBe(initial)
        expect(parseStoredFilm(serializeStoredFilm({ film: next, lanes: [] }))?.film).toEqual(
          initial,
        )
      }
    },
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '非有限的调整数值 %s 不写入草稿',
    (value) => {
      const initial = film()
      expect(trimSegment(initial, 's1', 'end', value, 8)).toBe(initial)
    },
  )

  it('在播放头处拆成两段，前一半留原 id；太靠边拆不了', () => {
    const split = splitAt(film(), 1.5, 'right')

    expect(order(split ?? EMPTY_FILM).slice(0, 2)).toEqual([
      ['s1', 'A', 0, 1.5],
      ['right', 'A', 1.5, 3],
    ])
    expect(canSplitAt(film().segments, 0.1)).toBe(false)
    expect(canSplitAt(film().segments, 3)).toBe(false)
  })

  it('删掉一段，后面的前移', () => {
    const removed = removeSegment(film(), 's2')

    expect(order(removed).map(([id]) => id)).toEqual(['s1', 's3'])
    expect(filmDuration(removed.segments)).toBe(4)
  })
})

describe('撤销重做', () => {
  it('插入、裁剪、改字都能一步步撤回再重做', () => {
    const start = film()
    const inserted = insertSegment(start, pick('C', 0, 1), 0, 'c') ?? start
    const edited = setSentenceText(inserted, 'sub#0', '改过的字')
    const history = commit(commit(startHistory(start), inserted), edited)

    const back = undo(undo(history))
    expect(back.present).toBe(start)
    expect(redo(back).present).toBe(inserted)
    expect(redo(redo(back)).present.texts).toEqual({ 'sub#0': '改过的字' })
  })
})

describe('音乐', () => {
  const gain = [
    { atMs: 0, gain: 0.25 },
    { atMs: 6000, gain: 0.5 },
  ]
  const restored = () =>
    setMusic(film(), {
      kind: 'generate',
      jobId: 'g1',
      userStart: 2.25,
      gain,
    })

  it('原声与音乐音量分别保留，存取与撤销重做后仍一致', () => {
    const before = restored()
    const adjusted = setMusicVolume(setSegmentVolume(before, 's1', 0), 1.5)
    const history = commit(startHistory(before), adjusted)
    expect(undo(history).present).toEqual(before)
    expect(redo(undo(history)).present).toEqual(adjusted)
    const reloaded = parseStoredFilm(serializeStoredFilm({ film: adjusted, lanes: [] }))
    expect(reloaded?.film).toEqual(adjusted)
    expect(adjusted.segments[0]?.volume).toBe(0)
    expect(adjusted.music?.volume).toBe(1.5)
    expect(adjusted.music?.gain).toEqual(gain)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 2.1])('拒绝非法音量 %s', (volume) => {
    expect(() => setSegmentVolume(film(), 's1', volume)).toThrow(RangeError)
    expect(() => setMusicVolume(restored(), volume)).toThrow(RangeError)
  })

  it('移动起点和恢复自动对齐保留混音快照，默认音量不产生新状态', () => {
    const state = restored()
    expect(setSegmentVolume(state, 's1', 1)).toBe(state)
    expect(setMusicVolume(state, 1)).toBe(state)
    const moved = moveMusic(state, 3.125) ?? state
    expect(moved.music?.gain).toEqual(gain)
    expect(resetMusicStart(moved).music).toMatchObject({ userStart: null, gain })
  })

  it('拆分、裁剪、换序保留段音量，并使旧正文曲线失效', () => {
    const state = setSegmentVolume(restored(), 's1', 0.4)
    const split = splitAt(state, 1, 'right')
    expect(split?.segments.slice(0, 2).map((segment) => segment.volume)).toEqual([0.4, 0.4])
    expect(split?.music?.gain).toBeUndefined()
    const trimmed = trimSegment(state, 's1', 'start', 0.5)
    expect(trimmed.segments[0]?.volume).toBe(0.4)
    expect(trimmed.music?.gain).toBeUndefined()
    const moved = moveSegment(state, 's1', 3)
    expect(moved?.segments.at(-1)?.volume).toBe(0.4)
    expect(moved?.music?.gain).toBeUndefined()
    expect(removeSegment(state, 's2').music?.gain).toBeUndefined()
    expect(insertSegment(state, pick('B', 0, 1), 0, 'new')?.music?.gain).toBeUndefined()
  })

  it('至多一首：放上新的换掉原来那首，拿掉就没有', () => {
    const uploaded = setMusic(film(), {
      kind: 'upload',
      jobId: 'u1',
      name: 'a.mp3',
      url: 'https://oss/u1',
      userStart: 3,
    })
    const generated = setMusic(uploaded, { kind: 'generate', jobId: 'g1', userStart: null })

    expect(generated.music).toEqual({ kind: 'generate', jobId: 'g1', userStart: null })
    expect(setMusic(generated, null).music).toBeNull()
  })

  it('拖音乐记下人选的起点（毫秒精度）；没挪动或没有音乐时不算一步', () => {
    const state = setMusic(film(), { kind: 'generate', jobId: 'g1', userStart: null })
    const moved = moveMusic(state, 4.00049)

    expect(moved?.music?.userStart).toBe(4)
    expect(moveMusic(moved ?? state, 4)).toBeUndefined()
    expect(moveMusic(film(), 1)).toBeUndefined()
  })
})

describe('素材轨', () => {
  it('同一原作切换编辑版本，不同次生成同时保留各自轨道', () => {
    const lanes = putLane(putLane([], { takeId: 'A', jobId: 'v1' }), {
      takeId: 'B',
      jobId: 'w1',
    })

    expect(putLane(lanes, { takeId: 'A', jobId: 'v2' })).toEqual([
      { takeId: 'A', jobId: 'v2' },
      { takeId: 'B', jobId: 'w1' },
    ])
  })
})

describe('存放', () => {
  it('草稿与素材轨序列化后原样读回', () => {
    const state = setSentenceText(trimSegment(film(), 's1', 'start', 1), 'sub#2', '新的字')
    const stored = { film: state, lanes: [{ takeId: 'A', jobId: 'A' }] }

    expect(parseStoredFilm(serializeStoredFilm(stored))).toEqual(stored)
  })

  it.each<FilmMusic>([
    { kind: 'upload', jobId: 'u1', name: '夏日节拍.mp3', url: 'https://oss/u1', userStart: 2.5 },
    { kind: 'generate', jobId: 'g1', userStart: null },
  ])('音乐（$kind）连同人拖到的起点原样读回', (music) => {
    const stored = { film: setMusic(film(), music), lanes: [] }

    expect(parseStoredFilm(serializeStoredFilm(stored))).toEqual(stored)
  })

  it('迁移旧草稿，保留剪辑并移除已废弃的选区约束', () => {
    const before = JSON.stringify({
      version: 1,
      segments: [{ id: 's1', sourceJobId: 'A', start: 0, end: 3, origin: [0, 3] }],
      texts: {},
      manual: [],
      lanes: [{ takeId: 'A', jobId: 'A' }],
    })

    expect(parseStoredFilm(before)?.film).toMatchObject({
      segments: [{ id: 's1', start: 0, end: 3 }],
      music: null,
    })
  })

  it('旧草稿按来源归到生成轨，保留没有 origin 的片段及同组不同生成', () => {
    const raw = JSON.stringify({
      version: 1,
      segments: [{ id: 'shot', sourceJobId: 'A-edit', start: 2, end: 5, volume: 0.65 }],
      texts: { 'sub#1': '字幕' },
      manual: [],
      lanes: [
        { groupId: 'group', jobId: 'A-edit' },
        { groupId: 'group', jobId: 'B' },
      ],
    })
    const restored = parseDraft(raw, (id) => (id === 'A-edit' ? 'A' : id))
    expect(restored?.lanes).toEqual([
      { takeId: 'A', jobId: 'A-edit' },
      { takeId: 'B', jobId: 'B' },
    ])
    expect(restored?.film.segments[0]).toEqual({
      id: 'shot',
      sourceJobId: 'A-edit',
      start: 2,
      end: 5,
      volume: 0.65,
    })
    const extended = trimSegment(restored?.film ?? EMPTY_FILM, 'shot', 'end', 6, 8)
    expect(extended.segments[0]?.end).toBe(6)
    expect(extended.texts).toEqual({ 'sub#1': '字幕' })
    const saved = serializeStoredFilm({ film: extended, lanes: restored?.lanes ?? [] })
    expect(JSON.parse(saved)).toMatchObject({ version: 2 })
    expect(parseDraft(saved, (id) => (id === 'A-edit' ? 'A' : id))?.film).toEqual(extended)
  })

  it.each([
    ['不是 JSON', '{'],
    [
      '格式版本不对',
      JSON.stringify({ version: 3, segments: [], texts: {}, manual: [], lanes: [] }),
    ],
    [
      '片段结尾早于起点',
      JSON.stringify({
        version: 1,
        segments: [{ id: 'x', sourceJobId: 'A', start: 5, end: 1, origin: [1, 5] }],
        texts: {},
        manual: [],
        lanes: [],
      }),
    ],
  ])('%s：读不出来', (_, raw) => {
    expect(parseStoredFilm(raw)).toBeUndefined()
  })

  it('来源读不到的段连同它的素材轨去掉，并说去掉了几段', () => {
    const gain = [
      { atMs: 0, gain: 0.2 },
      { atMs: 6000, gain: 0.5 },
    ]
    const state = setMusic(film(), {
      kind: 'generate',
      jobId: 'music',
      userStart: 1.25,
      volume: 0.4,
      gain,
    })
    const allKnown = keepKnownSources({ film: state, lanes: [] }, new Set(['A', 'B']))
    expect(allKnown.stored.film.music?.gain).toEqual(gain)
    const { stored, dropped } = keepKnownSources(
      {
        film: state,
        lanes: [
          { takeId: 'A', jobId: 'A' },
          { takeId: 'B', jobId: 'B' },
        ],
      },
      new Set(['A']),
    )

    expect(dropped).toBe(1)
    expect(order(stored.film).map(([id]) => id)).toEqual(['s1', 's3'])
    expect(stored.film.music?.gain).toBeUndefined()
    expect(stored.film.music).toMatchObject({ userStart: 1.25, volume: 0.4 })
    expect(stored.lanes).toEqual([{ takeId: 'A', jobId: 'A' }])
  })
})

describe('统一字幕字体', () => {
  const font = { fontId: 'brand-font', name: '品牌字体', url: 'https://example.com/brand.ttf' }
  it('字体选择经过草稿存取和撤销重做后保留，恢复系统字体显式保存空值', () => {
    const history = commit(startHistory(film()), setFont(film(), font))
    expect(undo(history).present.font).toBeUndefined()
    expect(redo(undo(history)).present.font).toEqual(font)
    const stored = parseStoredFilm(serializeStoredFilm({ film: history.present, lanes: [] }))
    expect(stored?.film.font).toEqual(font)
    expect(
      parseStoredFilm(serializeStoredFilm({ film: setFont(history.present, null), lanes: [] }))
        ?.film.font,
    ).toBeNull()
  })
})
