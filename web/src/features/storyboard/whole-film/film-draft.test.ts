import { describe, expect, it } from 'vitest'
import { commit, redo, startHistory, undo } from '../edit-history'
import {
  canSplitAt,
  EMPTY_FILM,
  filmDuration,
  insertClockOf,
  insertIndexAt,
  insertSegment,
  keepKnownSources,
  MAX_FILM_SECONDS,
  moveMusic,
  moveSegment,
  parseStoredFilm,
  putLane,
  removeSegment,
  serializeStoredFilm,
  setMusic,
  setSentenceText,
  splitAt,
  trimBounds,
  trimSegment,
  type FilmMusic,
  type FilmState,
  type Pick,
} from './film-draft'

const pick = (sourceJobId: string, start: number, end: number): Pick => ({
  sourceJobId,
  start,
  end,
})

/** 依次插在最后：A 0–3、B 1–3、A 5–6，共 6 秒。 */
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

  it('掐头去尾只能在挑进来的那一截里收缩、再放回，不短于最短时长', () => {
    const trimmed = trimSegment(film(), 's1', 'start', 1)
    expect(order(trimmed)[0]).toEqual(['s1', 'A', 1, 3])

    // 往回拉不超过挑进来时的起点。
    expect(order(trimSegment(trimmed, 's1', 'start', -5))[0]).toEqual(['s1', 'A', 0, 3])
    expect(order(trimSegment(trimmed, 's1', 'end', 9))[0]).toEqual(['s1', 'A', 1, 3])
    expect(order(trimSegment(trimmed, 's1', 'end', 1))[0]).toEqual(['s1', 'A', 1, 1.2])
  })

  it('裁剪拉长也不让整片超过上限', () => {
    const full = insertSegment(EMPTY_FILM, pick('A', 0, 100), 0, 'big')
    const trimmed = full === undefined ? EMPTY_FILM : trimSegment(full, 'big', 'end', 90)
    const plus = insertSegment(trimmed, pick('B', 0, 25), 1, 'b') ?? EMPTY_FILM
    const big = plus.segments[0]

    expect(filmDuration(plus.segments)).toBe(115)
    // 挑进来时到 100 秒，但整片只剩 5 秒的余量。
    expect(big === undefined ? undefined : trimBounds(plus.segments, big, 'end').max).toBe(95)
  })

  it('在播放头处拆成两段，前一半留原 id；太靠边拆不了', () => {
    const split = splitAt(film(), 1.5, 'right')

    expect(order(split ?? EMPTY_FILM).slice(0, 2)).toEqual([
      ['s1', 'A', 0, 1.5],
      ['right', 'A', 1.5, 3],
    ])
    expect(canSplitAt(film().segments, 0.1)).toBe(false)
    expect(canSplitAt(film().segments, 3)).toBe(false)
  })

  it('拆分后钉在后一半的手动字幕跟过去，钉在前一半的留着', () => {
    const withSubs: FilmState = {
      ...film(),
      manual: [
        { id: 'early', segmentId: 's1', at: 0.5, text: '' },
        { id: 'late', segmentId: 's1', at: 2.5, text: '' },
      ],
    }
    const split = splitAt(withSubs, 1.5, 'right')

    expect(split?.manual.map((item) => [item.id, item.segmentId, item.at])).toEqual([
      ['early', 's1', 0.5],
      ['late', 'right', 2.5],
    ])
  })

  it('删掉一段，后面的前移，钉在它上面的手动字幕一起删', () => {
    const withSub: FilmState = {
      ...film(),
      manual: [{ id: 'on-b', segmentId: 's2', at: 1.5, text: '' }],
    }
    const removed = removeSegment(withSub, 's2')

    expect(order(removed).map(([id]) => id)).toEqual(['s1', 's3'])
    expect(filmDuration(removed.segments)).toBe(4)
    expect(removed.manual).toEqual([])
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
  it('同一组只有一条轨：放进同组的另一版就换掉它，新的组排在最后', () => {
    const lanes = putLane(putLane([], { groupId: 'g1', jobId: 'v1' }), {
      groupId: 'g2',
      jobId: 'w1',
    })

    expect(putLane(lanes, { groupId: 'g1', jobId: 'v2' })).toEqual([
      { groupId: 'g1', jobId: 'v2' },
      { groupId: 'g2', jobId: 'w1' },
    ])
  })
})

describe('存放', () => {
  it('草稿与素材轨序列化后原样读回', () => {
    const state = setSentenceText(
      {
        ...trimSegment(film(), 's1', 'start', 1),
        manual: [{ id: 'm', segmentId: 's1', at: 2.5, text: '' }],
      },
      'sub#2',
      '新的字',
    )
    const stored = { film: state, lanes: [{ groupId: 'g1', jobId: 'A' }] }

    expect(parseStoredFilm(serializeStoredFilm(stored))).toEqual(stored)
  })

  it.each<FilmMusic>([
    { kind: 'upload', jobId: 'u1', name: '夏日节拍.mp3', url: 'https://oss/u1', userStart: 2.5 },
    { kind: 'generate', jobId: 'g1', userStart: null },
  ])('音乐（$kind）连同人拖到的起点原样读回', (music) => {
    const stored = { film: setMusic(film(), music), lanes: [] }

    expect(parseStoredFilm(serializeStoredFilm(stored))).toEqual(stored)
  })

  it('只加了音乐、格式版本没变：之前存的草稿照样读回，没有音乐', () => {
    const before = JSON.stringify({
      version: 1,
      segments: [{ id: 's1', sourceJobId: 'A', start: 0, end: 3, origin: [0, 3] }],
      texts: {},
      manual: [],
      lanes: [{ groupId: 'g1', jobId: 'A' }],
    })

    expect(parseStoredFilm(before)?.film).toMatchObject({
      segments: [{ id: 's1', start: 0, end: 3, origin: { start: 0, end: 3 } }],
      music: null,
    })
  })

  it.each([
    ['不是 JSON', '{'],
    [
      '格式版本不对',
      JSON.stringify({ version: 2, segments: [], texts: {}, manual: [], lanes: [] }),
    ],
    [
      '段落在挑进来的那一截外面',
      JSON.stringify({
        version: 1,
        segments: [{ id: 'x', sourceJobId: 'A', start: 0, end: 5, origin: [1, 5] }],
        texts: {},
        manual: [],
        lanes: [],
      }),
    ],
  ])('%s：读不出来', (_, raw) => {
    expect(parseStoredFilm(raw)).toBeUndefined()
  })

  it('来源读不到的段连同它的手动字幕与素材轨去掉，并说去掉了几段', () => {
    const state: FilmState = {
      ...film(),
      manual: [{ id: 'on-b', segmentId: 's2', at: 1.5, text: '' }],
    }
    const { stored, dropped } = keepKnownSources(
      {
        film: state,
        lanes: [
          { groupId: 'g1', jobId: 'A' },
          { groupId: 'g2', jobId: 'B' },
        ],
      },
      new Set(['A']),
    )

    expect(dropped).toBe(1)
    expect(order(stored.film).map(([id]) => id)).toEqual(['s1', 's3'])
    expect(stored.film.manual).toEqual([])
    expect(stored.lanes).toEqual([{ groupId: 'g1', jobId: 'A' }])
  })
})
