import { describe, expect, it } from 'vitest'
import { audio, component, picture } from '@/testing/whole-film'
import {
  gapClosing,
  groupShift,
  groupTrimmed,
  groupTrimRange,
  rippleStarts,
  trimBounds,
  trimmed,
  type Timing,
} from './block-edit'
import type { FilmBlock } from './composition/film'
import { zoneOf } from './placement'

const first = picture({ id: 'a', start: 0, duration: 2_000 })
const middle = picture({ id: 'b', start: 3_000, duration: 2_000, mediaStart: 1_500 })
const last = picture({ id: 'c', start: 6_000, duration: 1_000 })
const above = picture({ id: 'd', start: 2_000, duration: 5_000, track: 1 })
const film = [first, middle, last, above]

const VISUAL_0 = { zone: 'visual', track: 0 } as const

/** 每次改完都要满足的两条：同一行（同一个区、同一个行号）的块不重叠，起点不为负。 */
const expectValidFilm = (pictures: readonly FilmBlock[]) => {
  for (const block of pictures) {
    expect(block.start, `${block.id} 的起点`).toBeGreaterThanOrEqual(0)
    for (const other of pictures) {
      if (other === block || other.track !== block.track || zoneOf(other) !== zoneOf(block))
        continue
      const overlapping =
        block.start < other.start + other.duration && other.start < block.start + block.duration
      expect(overlapping, `${block.id} 和 ${other.id} 重叠`).toBe(false)
    }
  }
}

describe('裁剪一个块', () => {
  it('开头：往前不压到前一个块，也不早于素材的开头；往后至少留最短的长度', () => {
    expect(trimBounds(middle, 'start', film, 6_000)).toEqual({ min: 2_000, max: 4_900 })
    const tight = { ...middle, mediaStart: 400 }
    expect(trimBounds(tight, 'start', film, 6_000).min).toBe(2_600)
  })

  it('结尾：往后不压到后一个块，也不超出素材的结尾；别的行不挡路', () => {
    expect(trimBounds(middle, 'end', film, 10_000)).toEqual({ min: 3_100, max: 6_000 })
    expect(trimBounds(middle, 'end', film, 4_000).max).toBe(5_500)
    // 后面没有块：只受素材长度限制，成片多长都行
    expect(trimBounds(last, 'end', film, 200_000).max).toBe(206_000)
  })

  it('素材总长还不知道：结尾只能往里收', () => {
    expect(trimBounds(middle, 'end', film, undefined).max).toBe(5_000)
  })

  it('裁开头：起点和入点一起往后，结尾不动', () => {
    const bounds = trimBounds(middle, 'start', film, 6_000)
    expect(trimmed(middle, 'start', 3_400, bounds)).toEqual({
      start: 3_400,
      duration: 1_600,
      mediaStart: 1_900,
    })
    expect(trimmed(middle, 'start', 0, bounds)).toEqual({
      start: 2_000,
      duration: 3_000,
      mediaStart: 500,
    })
  })

  it('裁结尾：只改长度', () => {
    const bounds = trimBounds(middle, 'end', film, 10_000)
    expect(trimmed(middle, 'end', 9_000, bounds)).toEqual({
      start: 3_000,
      duration: 3_000,
      mediaStart: 1_500,
    })
  })

  it('2 倍速：结尾最多到（素材长 − 入点）÷ 2；开头往前最多拉回入点 ÷ 2，往后裁时入点动两倍', () => {
    // 第 3 秒起、素材从 1.5 秒放起；素材 6 秒，剩下 4.5 秒，2 倍速在成片里能放 2.25 秒
    const fast = { ...middle, playbackRate: 2 }
    const lone = [fast]
    expect(trimBounds(fast, 'end', lone, 6_000).max).toBe(5_250)
    expect(trimBounds({ ...middle, playbackRate: 0.5 }, 'end', lone, 6_000).max).toBe(12_000)
    const head = trimBounds(fast, 'start', lone, 6_000)
    expect(head.min).toBe(2_250)
    expect(trimmed(fast, 'start', 3_400, head)).toEqual({
      start: 3_400,
      duration: 1_600,
      mediaStart: 2_300,
    })
    expect(trimmed(fast, 'start', 0, head)).toEqual({
      start: 2_250,
      duration: 2_750,
      mediaStart: 0,
    })
  })

  it('音频块按它的速度算：0.5 倍速时剩下的音频在成片里放两倍长', () => {
    const slow = audio({ start: 1_000, duration: 1_000, mediaStart: 500, playbackRate: 0.5 })
    expect(trimBounds(slow, 'end', [slow], 2_000).max).toBe(4_000)
  })
})

describe('裁组件块和音频块', () => {
  // 画面区第 0 行：画面块 a（0–2 秒）、组件块 k（3–5 秒）；声音区第 0 行：音频块 m（2.5–4 秒）
  const title = component({ id: 'k', start: 3_000, duration: 2_000 })
  const music = audio({ id: 'm', start: 2_500, duration: 1_500, mediaStart: 1_000 })
  const mixed = [first, title, music]

  it('组件块裁开头：往后裁多少，从第几秒开始播就加多少', () => {
    const bounds = trimBounds(title, 'start', mixed, undefined)
    expect(trimmed(title, 'start', 3_400, bounds)).toEqual({
      start: 3_400,
      duration: 1_600,
      mediaStart: 400,
    })
  })

  it('组件块开头往前拉：从第几秒开始播跟着减，减到 0 为止；也不压到前一个块', () => {
    // 从头播的组件块开头不能往前拉
    expect(trimBounds(title, 'start', mixed, undefined)).toEqual({ min: 3_000, max: 4_900 })
    const late = { ...title, playbackStart: 600 }
    const bounds = trimBounds(late, 'start', mixed, undefined)
    expect(bounds).toEqual({ min: 2_400, max: 4_900 })
    expect(trimmed(late, 'start', 2_000, bounds)).toEqual({
      start: 2_400,
      duration: 2_600,
      mediaStart: 0,
    })
    const later = { ...title, playbackStart: 1_500 }
    expect(trimBounds(later, 'start', mixed, undefined).min).toBe(2_000)
  })

  it('组件块结尾没有上限：给了长度、长度没读到都不看，只被同一行后面的块挡住', () => {
    expect(trimBounds(title, 'end', mixed, 1_000).max).toBe(Infinity)
    expect(trimBounds(title, 'end', mixed, undefined).max).toBe(Infinity)
    const next = component({ id: 'n', start: 8_000 })
    expect(trimBounds(title, 'end', [...mixed, next], undefined).max).toBe(8_000)
  })

  it('音频块结尾最多拉到音频剩下的长度：从入点算起；开着循环也一样', () => {
    // 3 秒的音频从第 1 秒放起，还剩 2 秒：结尾最多到 2.5 + 2 = 4.5 秒
    expect(trimBounds(music, 'end', mixed, 3_000)).toEqual({ min: 2_600, max: 4_500 })
    expect(trimBounds({ ...music, loop: true }, 'end', mixed, 3_000).max).toBe(4_500)
    expect(trimBounds({ ...music, mediaStart: 0 }, 'end', mixed, 3_000).max).toBe(5_500)
  })

  it('音频的时长还没读到：结尾只能往里收', () => {
    expect(trimBounds(music, 'end', mixed, undefined)).toEqual({ min: 2_600, max: 4_000 })
  })

  it('音频块裁开头：不早于音频的开头，入点跟着动；别的区同号的行上的块不挡路', () => {
    const bounds = trimBounds(music, 'start', mixed, 3_000)
    expect(bounds).toEqual({ min: 1_500, max: 3_900 })
    expect(trimmed(music, 'start', 1_500, bounds)).toEqual({
      start: 1_500,
      duration: 2_500,
      mediaStart: 0,
    })
  })
})

// 新开的一行在测试里记成这个行号
const NEW_ROW = 99

/** 按 groupShift 的结果挪完以后的成片，连同结果本身。 */
const shifted = (
  pictures: readonly FilmBlock[],
  grabbed: FilmBlock,
  ids: readonly string[],
  wantedDelta: number,
  track: number | null,
) => {
  const group = new Set([grabbed.id, ...ids])
  const result = groupShift(grabbed, group, pictures, wantedDelta, track)
  const after = pictures.map((block) =>
    group.has(block.id)
      ? {
          ...block,
          start: block.start + result.delta,
          track: block.id === grabbed.id ? (result.track ?? NEW_ROW) : block.track,
        }
      : block,
  )
  expectValidFilm(after)
  return result
}

describe('挪一个块（只有它自己的一组）', () => {
  const offGrid = picture({ id: 'e', start: 0, duration: 1_234, track: 2 })
  const nearOffGrid = picture({ id: 'h', start: 2_005, duration: 1_000, track: 2 })
  const packed = picture({ id: 'p', start: 0, duration: 117_500, track: 3 })
  const tail = picture({ id: 'q', start: 118_000, duration: 2_000, track: 3 })
  const lone = picture({ id: 't', start: 1_000, duration: 1_000, track: 4 })
  const short = picture({ id: 's', start: 3_000, duration: 400, track: 4 })
  const spare = picture({ id: 'k', start: 0, duration: 1_000, track: 5 })
  const table = [...film, offGrid, nearOffGrid, packed, tail, lone, short, spare]
  // 每条：块、想要的起点、要去的行、最后的起点
  const cases: [string, FilmBlock, number, number, number][] = [
    ['挪到空处', middle, 2_200, 0, 2_200],
    ['落点被占：落到最近的空位', middle, 5_200, 0, 4_000],
    ['自己原来的位置不算占用', middle, 3_500, 0, 3_500],
    ['空位不够长：接在这一行最后一个块后面', above, 2_500, 0, 7_000],
    ['拖到很后面：成片多长都行', last, 500_000, 0, 500_000],
    ['别的行不挡路', first, 0, 1, 0],
    ['换到别的行、落点被占：落到最近的空位', first, 3_000, 1, 0],
    ['两边一样近：取靠后的', spare, 1_000, 4, 2_000],
    ['长度不在 10 毫秒上', offGrid, 1_900, 0, 7_000],
    ['邻居的边不在 10 毫秒上', nearOffGrid, 1_000, 2, 1_240],
    ['两个块中间有放得下的空位', short, 117_000, 3, 117_500],
  ]

  it.each(cases)('%s', (_, block, wantedStart, track, start) => {
    const result = shifted(table, block, [], wantedStart - block.start, track)
    expect(block.start + result.delta).toBe(start)
    expect(result.track).toBe(track)
  })

  it('要去的行中间的空放不下：接在那一行最后一个块后面', () => {
    // 第四行从 0 排到 117.5 秒、118 到 120 秒，中间只有半秒的空：1 秒长的块放不进去
    expect(shifted(table, last, [], 111_000, 3)).toEqual({ delta: 114_000, track: 3 })
  })

  it('新开一行：想放在哪就放在哪', () => {
    for (const wantedStart of [500, 500_000]) {
      const result = shifted(table, last, [], wantedStart - last.start, null)
      expect(last.start + result.delta).toBe(wantedStart)
      expect(result.track).toBeNull()
    }
  })
})

describe('成组挪动', () => {
  // 第一行：选中的 f，没选中的 o；第二行：选中的 g（被抓的块）；第三行：没选中的 y
  const follower = picture({ id: 'f', start: 0, duration: 2_000 })
  const obstacle = picture({ id: 'o', start: 3_000, duration: 2_000 })
  const grabbed = picture({ id: 'g', start: 1_000, duration: 1_000, track: 1 })
  const blocker = picture({ id: 'y', start: 2_500, duration: 1_500, track: 2 })
  const pictures = [follower, obstacle, grabbed, blocker]

  it('同伴会压到没选中的块：整组停在大家都放得下的地方', () => {
    expect(shifted(pictures, grabbed, ['f'], 1_500, 1)).toEqual({ delta: 1_000, track: 1 })
  })

  it('同伴放得下就照想要的挪；同一行的同伴互相不挡路', () => {
    expect(shifted(pictures, grabbed, ['f'], 600, 1)).toEqual({ delta: 600, track: 1 })
    const next = picture({ id: 'n', start: 2_000, duration: 1_000 })
    const row = [follower, next, picture({ id: 'z', start: 6_000, duration: 1_000 })]
    expect(shifted(row, next, ['f'], 1_500, 0)).toEqual({ delta: 1_500, track: 0 })
  })

  it('被抓的块换到有时间重叠的同伴的那一行：不许换，留在自己那一行挪', () => {
    expect(shifted(pictures, grabbed, ['f'], 500, 0)).toEqual({ delta: 500, track: 1 })
  })

  it('被抓的块换到另一行、那里有别的块挡路：取两边都放得下的最近处', () => {
    expect(shifted(pictures, grabbed, ['f'], 1_000, 2)).toEqual({ delta: 500, track: 2 })
  })

  it('被抓的块新开一行：新的一行上没有别的块，同伴照样要避让', () => {
    expect(shifted(pictures, grabbed, ['f'], 1_500, null)).toEqual({ delta: 1_000, track: null })
  })

  it('被抓的块要去的行前面都占满了：整组挪到它能接在那一行最后一个块后面的地方', () => {
    const full = picture({ id: 'w', start: 0, duration: 119_500, track: 3 })
    expect(shifted([...pictures, full], grabbed, ['f'], 500, 3)).toEqual({
      delta: 118_500,
      track: 3,
    })
  })

  it('整组往前顶到 0：最靠前的块停在 0', () => {
    const late = picture({ id: 'l', start: 4_000, duration: 1_000, track: 1 })
    const early = picture({ id: 'e', start: 800, duration: 1_000, track: 2 })
    expect(shifted([late, early], late, ['e'], -3_000, 1)).toEqual({ delta: -800, track: 1 })
  })

  it('同伴是音频块：它只避让声音区同号那一行上的块，画面区同号的行不挡它', () => {
    // f 在画面区第 0 行；选中的音频块 s 在声音区第 0 行，后面有没选中的音频块 q
    const sound = audio({ id: 's', start: 0, duration: 1_000 })
    const queued = audio({ id: 'q', start: 2_500, duration: 1_000 })
    const film = [...pictures, sound, queued]
    // 挪 1 秒：s 到 1–2 秒，不碰 q；画面区第 0 行的 o（3–5 秒）不挡 s
    expect(shifted(film, grabbed, ['s'], 1_000, 1)).toEqual({ delta: 1_000, track: 1 })
    // 想挪 2 秒：s 会压到 q，整组退到 s 刚好接在 q 前面
    expect(shifted(film, grabbed, ['s'], 2_000, 1)).toEqual({ delta: 1_500, track: 1 })
  })

  it('被抓的音频块换到声音区的另一行：只看那一行的音频块，画面区同号的行不挡路', () => {
    const sound = audio({ id: 's', start: 0, duration: 1_000 })
    const other = audio({ id: 'q', start: 4_000, duration: 1_000, track: 1 })
    // 声音区第 1 行只有 q（4–5 秒）；画面区第 1 行的 g（1–2 秒）不挡
    expect(shifted([...pictures, sound, other], sound, [], 1_000, 1)).toEqual({
      delta: 1_000,
      track: 1,
    })
  })

  it('整组往后挪：成片多长都行', () => {
    const end = picture({ id: 'l', start: 110_000, duration: 5_000, track: 1 })
    const head = picture({ id: 'e', start: 100_000, duration: 1_000, track: 2 })
    expect(shifted([end, head], head, ['l'], 20_000, 2)).toEqual({ delta: 20_000, track: 2 })
  })
})

describe('成组裁剪', () => {
  // 第一行：相邻的 l、r，后面隔开的 n；第二行：u
  const left = picture({ id: 'l', start: 0, duration: 2_000, mediaStart: 500, src: 'l.mp4' })
  const right = picture({ id: 'r', start: 2_000, duration: 2_000, src: 'r.mp4' })
  const next = picture({ id: 'n', start: 6_000, duration: 1_000, src: 'n.mp4' })
  const upper = picture({
    id: 'u',
    start: 1_000,
    duration: 2_000,
    mediaStart: 1_000,
    src: 'u.mp4',
    track: 1,
  })
  const pictures = [left, right, next, upper]
  const sources = new Map([
    ['l.mp4', 10_000],
    ['r.mp4', 3_000],
    ['n.mp4', 10_000],
    ['u.mp4', 5_000],
  ])
  const known = (block: FilmBlock) => sources.get(block.src)

  /** 一起裁完以后的成片；先检查三条，再按块给出各自的起止和入点。 */
  const trimmedGroup = (
    members: readonly FilmBlock[],
    edge: 'start' | 'end',
    delta: number,
    sourceMs = known,
  ) => {
    const timings = groupTrimmed(members, edge, delta, pictures, sourceMs)
    expectValidFilm(pictures.map((block) => ({ ...block, ...timings.get(block.id) })))
    return Object.fromEntries(timings) as Record<string, Timing>
  }

  it('同一行相邻的两个一起裁结尾：往外拉被后一个块挡住，往里收两个一起收', () => {
    expect(groupTrimRange([left, right], 'end', pictures, known)).toEqual({ min: -1_900, max: 0 })
    expect(trimmedGroup([left, right], 'end', 500)).toEqual({
      l: { start: 0, duration: 2_000, mediaStart: 500 },
      r: { start: 2_000, duration: 2_000, mediaStart: 0 },
    })
    expect(trimmedGroup([left, right], 'end', -500)).toEqual({
      l: { start: 0, duration: 1_500, mediaStart: 500 },
      r: { start: 2_000, duration: 1_500, mediaStart: 0 },
    })
  })

  it('同一行相邻的两个一起裁开头：往前拉被前一个块挡住，往后收起点和入点一起动', () => {
    expect(trimmedGroup([left, right], 'start', -300)).toEqual({
      l: { start: 0, duration: 2_000, mediaStart: 500 },
      r: { start: 2_000, duration: 2_000, mediaStart: 0 },
    })
    expect(trimmedGroup([left, right], 'start', 400)).toEqual({
      l: { start: 400, duration: 1_600, mediaStart: 900 },
      r: { start: 2_400, duration: 1_600, mediaStart: 400 },
    })
  })

  it('不同行的两个一起往外拉：按素材剩得最少的那个收住', () => {
    expect(trimmedGroup([right, upper], 'end', 2_000)).toEqual({
      r: { start: 2_000, duration: 3_000, mediaStart: 0 },
      u: { start: 1_000, duration: 3_000, mediaStart: 1_000 },
    })
  })

  it('一起往里收：按最短的长度收住', () => {
    expect(trimmedGroup([left, upper], 'end', -5_000)).toEqual({
      l: { start: 0, duration: 100, mediaStart: 500 },
      u: { start: 1_000, duration: 100, mediaStart: 1_000 },
    })
  })

  it('有一个块的素材总长还没读到：结尾不能往外拉，往里收照样可以', () => {
    const unread = (block: FilmBlock) => (block.src === 'u.mp4' ? undefined : known(block))
    expect(trimmedGroup([right, upper], 'end', 1_000, unread)).toEqual({
      r: { start: 2_000, duration: 2_000, mediaStart: 0 },
      u: { start: 1_000, duration: 2_000, mediaStart: 1_000 },
    })
    expect(trimmedGroup([right, upper], 'end', -500, unread)).toEqual({
      r: { start: 2_000, duration: 1_500, mediaStart: 0 },
      u: { start: 1_000, duration: 1_500, mediaStart: 1_000 },
    })
  })

  it('三种块一起裁：同一个量，按最受限的那个收住；组件块从第几秒开始播跟着动，结尾不受长度限制', () => {
    // 画面区第 0 行：画面块 p（1–3 秒，入点 0.5 秒，素材 4 秒）；第 1 行：组件块 k（1–3 秒，从第 0.3 秒播）；
    // 声音区第 0 行：音频块 a（2–3 秒，入点 1 秒，音频 2.5 秒）
    const shot = picture({ id: 'p', start: 1_000, duration: 2_000, mediaStart: 500, src: 'p.mp4' })
    const title = component({
      id: 'k',
      start: 1_000,
      duration: 2_000,
      playbackStart: 300,
      track: 1,
    })
    const music = audio({ id: 'a', start: 2_000, duration: 1_000, mediaStart: 1_000, src: 'a.mp3' })
    const blocks = [shot, title, music]
    const lengths = new Map([
      ['p.mp4', 4_000],
      ['a.mp3', 2_500],
    ])
    const lengthOf = (block: FilmBlock) => lengths.get(block.src)
    const together = (edge: 'start' | 'end', delta: number) => {
      const timings = groupTrimmed(blocks, edge, delta, blocks, lengthOf)
      expectValidFilm(blocks.map((block) => ({ ...block, ...timings.get(block.id) })))
      return Object.fromEntries(timings) as Record<string, Timing>
    }
    // 开头往前拉 1 秒：组件块只能往前 0.3 秒（画面块 0.5 秒、音频块 1 秒）
    expect(together('start', -1_000)).toEqual({
      p: { start: 700, duration: 2_300, mediaStart: 200 },
      k: { start: 700, duration: 2_300, mediaStart: 0 },
      a: { start: 1_700, duration: 1_300, mediaStart: 700 },
    })
    // 开头往后裁 0.5 秒：三个的入点都加 0.5 秒
    expect(together('start', 500)).toEqual({
      p: { start: 1_500, duration: 1_500, mediaStart: 1_000 },
      k: { start: 1_500, duration: 1_500, mediaStart: 800 },
      a: { start: 2_500, duration: 500, mediaStart: 1_500 },
    })
    // 结尾往后拉 5 秒：音频只剩 0.5 秒（画面块还能拉 1.5 秒，组件块不限）
    expect(together('end', 5_000)).toEqual({
      p: { start: 1_000, duration: 2_500, mediaStart: 500 },
      k: { start: 1_000, duration: 2_500, mediaStart: 300 },
      a: { start: 2_000, duration: 1_500, mediaStart: 1_000 },
    })
  })

  it('只有一个块：和单独裁它一样', () => {
    for (const [edge, timeMs] of [
      ['start', 1_200],
      ['start', -1_000],
      ['end', 9_000],
      ['end', 2_050],
    ] as const) {
      const edgeMs = edge === 'start' ? upper.start : upper.start + upper.duration
      expect(trimmedGroup([upper], edge, timeMs - edgeMs)['u']).toEqual(
        trimmed(upper, edge, timeMs, trimBounds(upper, edge, pictures, known(upper))),
      )
    }
  })
})

describe('合拢空档', () => {
  it('点在两个块之间的空档上：它后面这一行的块都往前挪这个空档的宽度', () => {
    const closing = gapClosing(film, VISUAL_0, 2_500)
    expect([...closing.one]).toEqual([
      ['b', 2_000],
      ['c', 5_000],
    ])
    expect([...closing.all]).toEqual([
      ['b', 2_000],
      ['c', 4_000],
    ])
  })

  it('点在块上，或者点在最后一个块后面：没有这一个空档可合拢', () => {
    expect(gapClosing(film, VISUAL_0, 1_000).one.size).toBe(0)
    expect(gapClosing(film, VISUAL_0, 9_000).one.size).toBe(0)
  })

  it('这一行没有空档：两种都没有可挪的；开头的空也算空档', () => {
    const tight = [first, picture({ id: 'e', start: 2_000, duration: 1_000 })]
    expect(gapClosing(tight, VISUAL_0, 5_000).all.size).toBe(0)
    expect([...gapClosing(film, { zone: 'visual', track: 1 }, 500).one]).toEqual([['d', 0]])
  })

  it('只合拢这个区这一行的块：声音区第 0 行和画面区第 0 行各算各的', () => {
    const music = audio({ id: 'm', start: 4_000, duration: 1_000 })
    expect([...gapClosing([...film, music], { zone: 'audio', track: 0 }, 1_000).one]).toEqual([
      ['m', 0],
    ])
    expect([...gapClosing([...film, music], VISUAL_0, 2_500).all]).toEqual([
      ['b', 2_000],
      ['c', 4_000],
    ])
  })
})

describe('波纹编辑', () => {
  it('删掉第一行的块：它后面第一行的块往前补上它的长度，别的行不动', () => {
    expect([...rippleStarts(film, new Set(['a']))]).toEqual([
      ['b', 1_000],
      ['c', 4_000],
    ])
  })

  it('一次删几个：每个块挪的是它前面被删掉的总长', () => {
    expect([...rippleStarts(film, new Set(['a', 'b']))]).toEqual([['c', 2_000]])
  })

  it('删的不是第一行的块：谁都不动', () => {
    expect(rippleStarts(film, new Set(['d'])).size).toBe(0)
  })

  it('第一行是最上面那一行，行号不一定是 0', () => {
    const lowered = film.map((block) => ({ ...block, track: block.track + 3 }))
    expect([...rippleStarts(lowered, new Set(['a']))]).toEqual([
      ['b', 1_000],
      ['c', 4_000],
    ])
    expect(rippleStarts(lowered, new Set(['d'])).size).toBe(0)
  })

  it('主轨是画面区最上面那一行：组件块在那一行就跟着补；音频块行号再小也不算', () => {
    const title = component({ id: 'k', start: 7_000, duration: 1_000, track: 2 })
    const raised = [...film.map((block) => ({ ...block, track: block.track + 2 })), title]
    const music = audio({ id: 'm', start: 3_000, duration: 1_000, track: 0 })
    expect([...rippleStarts([...raised, music], new Set(['a']))]).toEqual([
      ['b', 1_000],
      ['c', 4_000],
      ['k', 5_000],
    ])
    expect(rippleStarts([...raised, music], new Set(['m'])).size).toBe(0)
  })
})
