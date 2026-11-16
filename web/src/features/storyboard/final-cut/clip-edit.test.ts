import { describe, expect, it } from 'vitest'
import { audio, caption, host, video } from '@/testing/final-cut'
import {
  editGroup,
  gapClosing,
  groupShift,
  groupTrimmed,
  groupTrimRange,
  linkedGroup,
  linkedPartners,
  playheadSplit,
  razorSplit,
  rippleStarts,
  slipped,
  sourceTrimmed,
  splitAllAt,
  splitAt,
  SPLIT_REFUSAL_TEXT,
  trimBounds,
  trimmed,
  withLinkedStarts,
  type Links,
  type Timing,
} from './clip-edit'
import { MIN_CLIP_MS, type FilmClip } from './composition/film'
import { zoneOf } from './placement'

const first = video({ id: 'a', start: 0, duration: 2_000 })
const middle = video({ id: 'b', start: 3_000, duration: 2_000, mediaStart: 1_500 })
const last = video({ id: 'c', start: 6_000, duration: 1_000 })
const above = video({ id: 'd', start: 2_000, duration: 5_000, track: 1 })
const film = [first, middle, last, above]

const VISUAL_0 = { zone: 'visual', track: 0 } as const

/** 片段写着的地址：素材地址或条目文件；「其他」片段和字幕没有。 */
const srcOf = (clip: FilmClip) => (clip.kind === 'other' || clip.kind === 'caption' ? '' : clip.src)

/** 每次改完都要满足的两条：同一行（同一个区、同一个行号）的片段不重叠，起点不为负。 */
const expectValidFilm = (clips: readonly FilmClip[]) => {
  for (const clip of clips) {
    expect(clip.start, `${clip.id} 的起点`).toBeGreaterThanOrEqual(0)
    for (const other of clips) {
      if (other === clip || other.track !== clip.track || zoneOf(other) !== zoneOf(clip)) continue
      const overlapping =
        clip.start < other.start + other.duration && other.start < clip.start + clip.duration
      expect(overlapping, `${clip.id} 和 ${other.id} 重叠`).toBe(false)
    }
  }
}

describe('裁剪一个片段', () => {
  it('开头：往前不压到前一个片段，也不早于素材的开头；往后至少留最短的长度', () => {
    expect(trimBounds(middle, 'start', film, 6_000)).toEqual({ min: 2_000, max: 4_900 })
    const tight = { ...middle, mediaStart: 400 }
    expect(trimBounds(tight, 'start', film, 6_000).min).toBe(2_600)
  })

  it('结尾：往后不压到后一个片段，也不超出素材的结尾；别的行不挡路', () => {
    expect(trimBounds(middle, 'end', film, 10_000)).toEqual({ min: 3_100, max: 6_000 })
    expect(trimBounds(middle, 'end', film, 4_000).max).toBe(5_500)
    // 后面没有片段：只受素材长度限制，final-cut 多长都行
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
    // 第 3 秒起、素材从 1.5 秒放起；素材 6 秒，剩下 4.5 秒，2 倍速在 final-cut 里能放 2.25 秒
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

  it('音频片段按它的速度算：0.5 倍速时剩下的音频在 final-cut 里放两倍长', () => {
    const slow = audio({ start: 1_000, duration: 1_000, mediaStart: 500, playbackRate: 0.5 })
    expect(trimBounds(slow, 'end', [slow], 2_000).max).toBe(4_000)
  })
})

describe('裁组件或块的片段和音频片段', () => {
  // 画面区第 0 行：视频片段 a（0–2 秒）、组件或块的片段 k（3–5 秒）；声音区第 0 行：音频片段 m（2.5–4 秒）
  const title = host({ id: 'k', start: 3_000, duration: 2_000 })
  const music = audio({ id: 'm', start: 2_500, duration: 1_500, mediaStart: 1_000 })
  const mixed = [first, title, music]

  it('组件或块的片段裁开头：往后裁多少，从第几秒开始播就加多少', () => {
    const bounds = trimBounds(title, 'start', mixed, undefined)
    expect(trimmed(title, 'start', 3_400, bounds)).toEqual({
      start: 3_400,
      duration: 1_600,
      mediaStart: 400,
    })
  })

  it('组件或块的片段开头往前拉：从第几秒开始播跟着减，减到 0 为止；也不压到前一个片段', () => {
    // 从头播的组件或块的片段开头不能往前拉
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

  it('「其他」片段没有入点：开头往前只被前一个片段挡住，结尾没有上限', () => {
    const other: FilmClip = {
      kind: 'other',
      id: 'o',
      label: '手写文字',
      start: 3_000,
      duration: 2_000,
      track: 0,
      hidden: false,
      link: null,
      z: 0,
    }
    const row = [first, other]
    expect(trimBounds(other, 'start', row, undefined)).toEqual({ min: 2_000, max: 4_900 })
    expect(trimmed(other, 'start', 2_500, trimBounds(other, 'start', row, undefined))).toEqual({
      start: 2_500,
      duration: 2_500,
      mediaStart: 0,
    })
    expect(trimBounds(other, 'end', row, undefined).max).toBe(Infinity)
  })

  it('字幕没有入点：开头往前只被前一句挡住，结尾只被后一句挡住，同一时间的视频片段不挡', () => {
    const before = caption({ id: 'cap-0', start: 0, duration: 1_000 })
    const one = caption({ start: 3_000, duration: 2_000 })
    const after = caption({ id: 'cap-2', start: 6_000, duration: 1_000 })
    const row = [first, middle, before, one, after]
    expect(trimBounds(one, 'start', row, undefined)).toEqual({ min: 1_000, max: 4_900 })
    expect(trimBounds(one, 'end', row, undefined)).toEqual({ min: 3_100, max: 6_000 })
    expect(trimmed(one, 'start', 1_500, trimBounds(one, 'start', row, undefined))).toEqual({
      start: 1_500,
      duration: 3_500,
      mediaStart: 0,
    })
  })

  it('组件或块的片段结尾没有上限：给了长度、长度没读到都不看，只被同一行后面的片段挡住', () => {
    expect(trimBounds(title, 'end', mixed, 1_000).max).toBe(Infinity)
    expect(trimBounds(title, 'end', mixed, undefined).max).toBe(Infinity)
    const next = host({ id: 'n', start: 8_000 })
    expect(trimBounds(title, 'end', [...mixed, next], undefined).max).toBe(8_000)
  })

  it('音频片段结尾最多拉到音频剩下的长度：从入点算起；开着循环也一样', () => {
    // 3 秒的音频从第 1 秒放起，还剩 2 秒：结尾最多到 2.5 + 2 = 4.5 秒
    expect(trimBounds(music, 'end', mixed, 3_000)).toEqual({ min: 2_600, max: 4_500 })
    expect(trimBounds({ ...music, loop: true }, 'end', mixed, 3_000).max).toBe(4_500)
    expect(trimBounds({ ...music, mediaStart: 0 }, 'end', mixed, 3_000).max).toBe(5_500)
  })

  it('音频的时长还没读到：结尾只能往里收', () => {
    expect(trimBounds(music, 'end', mixed, undefined)).toEqual({ min: 2_600, max: 4_000 })
  })

  it('音频片段裁开头：不早于音频的开头，入点跟着动；别的区同号的行上的片段不挡路', () => {
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

/** 按 groupShift 的结果挪完以后的 final-cut，连同结果本身。 */
const shifted = (
  clips: readonly FilmClip[],
  grabbed: FilmClip,
  ids: readonly string[],
  wantedDelta: number,
  track: number | null,
) => {
  const group = new Set([grabbed.id, ...ids])
  const result = groupShift(grabbed, group, clips, wantedDelta, track)
  const after = clips.map((clip) =>
    group.has(clip.id)
      ? {
          ...clip,
          start: clip.start + result.delta,
          track: clip.id === grabbed.id ? (result.track ?? NEW_ROW) : clip.track,
        }
      : clip,
  )
  expectValidFilm(after)
  return result
}

describe('原片截取', () => {
  // 素材 6 秒；片段在 final-cut 的 1–3 秒，用素材的 2–4 秒；同一行 4 秒处有下一个片段，别的行不挡路
  const SOURCE = 6_000
  const clip = video({ id: 's', start: 1_000, duration: 2_000, mediaStart: 2_000 })
  const next = video({ id: 'n', start: 4_000, duration: 1_000 })
  const elsewhere = video({ id: 'o', start: 3_000, duration: 1_000, track: 1 })
  const row = [clip, next, elsewhere]
  const alone = [clip, elsewhere]

  it('拖入点：出点不动，片段的开始不动、时长跟着变；往前拉碰到后面的片段就停，不早于素材开头', () => {
    expect(slipped(clip, 'start', 2_500, row, SOURCE)).toEqual({
      start: 1_000,
      duration: 1_500,
      mediaStart: 2_500,
    })
    // 后面的片段在 4 秒：时长最多 3 秒，入点最早到 1 秒
    expect(slipped(clip, 'start', 0, row, SOURCE)).toEqual({
      start: 1_000,
      duration: 3_000,
      mediaStart: 1_000,
    })
    expect(slipped(clip, 'start', -500, alone, SOURCE)).toEqual({
      start: 1_000,
      duration: 4_000,
      mediaStart: 0,
    })
  })

  it('拖入点：出点在素材最后时也能往前拉，只被后面的片段挡住', () => {
    const atEnd = video({ id: 'e', start: 0, duration: 2_000, mediaStart: 4_000 })
    expect(slipped(atEnd, 'start', 0, [atEnd], SOURCE)).toEqual({
      start: 0,
      duration: 6_000,
      mediaStart: 0,
    })
    const blocker = video({ id: 'b', start: 3_000, duration: 1_000 })
    expect(slipped(atEnd, 'start', 0, [atEnd, blocker], SOURCE)).toEqual({
      start: 0,
      duration: 3_000,
      mediaStart: 3_000,
    })
  })

  it('拖入点：往后推最多到出点前留够最短时长', () => {
    expect(slipped(clip, 'start', 3_990, row, SOURCE)).toEqual({
      start: 1_000,
      duration: MIN_CLIP_MS,
      mediaStart: 4_000 - MIN_CLIP_MS,
    })
  })

  it('拖出点：入点不动；往外碰到后面的片段、素材结尾就停，往里留够最短时长', () => {
    expect(slipped(clip, 'end', 3_500, row, SOURCE)).toEqual({
      start: 1_000,
      duration: 1_500,
      mediaStart: 2_000,
    })
    expect(slipped(clip, 'end', 6_000, row, SOURCE).duration).toBe(3_000)
    expect(slipped(clip, 'end', 9_000, alone, SOURCE).duration).toBe(4_000)
    expect(slipped(clip, 'end', 0, row, SOURCE).duration).toBe(MIN_CLIP_MS)
  })

  it('拖整段：时长不变，框的正中对到指针处，收在素材里', () => {
    expect(slipped(clip, 'body', 3_000, row, SOURCE)).toEqual({
      start: 1_000,
      duration: 2_000,
      mediaStart: 2_000,
    })
    expect(slipped(clip, 'body', 1_200, row, SOURCE).mediaStart).toBe(200)
    expect(slipped(clip, 'body', 500, row, SOURCE).mediaStart).toBe(0)
    expect(slipped(clip, 'body', 5_900, row, SOURCE).mediaStart).toBe(4_000)
    // 后面的片段不挡：时长没变，不会压过去
    expect(slipped(clip, 'body', 5_900, row, SOURCE).duration).toBe(2_000)
  })

  it('2 倍速：用掉的素材是时长的两倍；入点、出点按素材时间换成 final-cut 的时长', () => {
    // final-cut 的 0–1 秒，用素材的 1–3 秒
    const fast = video({ id: 'f', start: 0, duration: 1_000, mediaStart: 1_000, playbackRate: 2 })
    expect(slipped(fast, 'end', 5_000, [fast], SOURCE)).toEqual({
      start: 0,
      duration: 2_000,
      mediaStart: 1_000,
    })
    // 素材剩下 5 秒，2 倍速只够放 2.5 秒
    expect(slipped(fast, 'end', 9_000, [fast], SOURCE).duration).toBe(2_500)
    expect(slipped(fast, 'start', 0, [fast], SOURCE)).toEqual({
      start: 0,
      duration: 1_500,
      mediaStart: 0,
    })
    expect(slipped(fast, 'start', 3_000, [fast], SOURCE)).toEqual({
      start: 0,
      duration: MIN_CLIP_MS,
      mediaStart: 3_000 - MIN_CLIP_MS * 2,
    })
    expect(slipped(fast, 'body', 6_000, [fast], SOURCE).mediaStart).toBe(4_000)
  })

  it('开着循环的音频用掉的比素材还长：整段只能从 0 开始', () => {
    const looped = audio({ duration: 8_000, loop: true })
    expect(slipped(looped, 'body', 3_000, [looped], SOURCE)).toEqual({
      start: 0,
      duration: 8_000,
      mediaStart: 0,
    })
  })
})

describe('挪一个片段（只有它自己的一组）', () => {
  const offGrid = video({ id: 'e', start: 0, duration: 1_234, track: 2 })
  const nearOffGrid = video({ id: 'h', start: 2_005, duration: 1_000, track: 2 })
  const packed = video({ id: 'p', start: 0, duration: 117_500, track: 3 })
  const tail = video({ id: 'q', start: 118_000, duration: 2_000, track: 3 })
  const lone = video({ id: 't', start: 1_000, duration: 1_000, track: 4 })
  const short = video({ id: 's', start: 3_000, duration: 400, track: 4 })
  const spare = video({ id: 'k', start: 0, duration: 1_000, track: 5 })
  const table = [...film, offGrid, nearOffGrid, packed, tail, lone, short, spare]
  // 每条：片段、想要的起点、要去的行、最后的起点
  const cases: [string, FilmClip, number, number, number][] = [
    ['挪到空处', middle, 2_200, 0, 2_200],
    ['落点被占：落到最近的空位', middle, 5_200, 0, 4_000],
    ['自己原来的位置不算占用', middle, 3_500, 0, 3_500],
    ['空位不够长：接在这一行最后一个片段后面', above, 2_500, 0, 7_000],
    ['拖到很后面：final-cut 多长都行', last, 500_000, 0, 500_000],
    ['别的行不挡路', first, 0, 1, 0],
    ['换到别的行、落点被占：落到最近的空位', first, 3_000, 1, 0],
    ['两边一样近：取靠后的', spare, 1_000, 4, 2_000],
    ['长度不在 10 毫秒上', offGrid, 1_900, 0, 7_000],
    ['邻居的边不在 10 毫秒上', nearOffGrid, 1_000, 2, 1_240],
    ['两个片段中间有放得下的空位', short, 117_000, 3, 117_500],
  ]

  it.each(cases)('%s', (_, clip, wantedStart, track, start) => {
    const result = shifted(table, clip, [], wantedStart - clip.start, track)
    expect(clip.start + result.delta).toBe(start)
    expect(result.track).toBe(track)
  })

  it('要去的行中间的空放不下：接在那一行最后一个片段后面', () => {
    // 第四行从 0 排到 117.5 秒、118 到 120 秒，中间只有半秒的空：1 秒长的片段放不进去
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
  // 第一行：选中的 f，没选中的 o；第二行：选中的 g（被抓的片段）；第三行：没选中的 y
  const follower = video({ id: 'f', start: 0, duration: 2_000 })
  const obstacle = video({ id: 'o', start: 3_000, duration: 2_000 })
  const grabbed = video({ id: 'g', start: 1_000, duration: 1_000, track: 1 })
  const blocker = video({ id: 'y', start: 2_500, duration: 1_500, track: 2 })
  const videos = [follower, obstacle, grabbed, blocker]

  it('同伴会压到没选中的片段：整组停在大家都放得下的地方', () => {
    expect(shifted(videos, grabbed, ['f'], 1_500, 1)).toEqual({ delta: 1_000, track: 1 })
  })

  it('同伴放得下就照想要的挪；同一行的同伴互相不挡路', () => {
    expect(shifted(videos, grabbed, ['f'], 600, 1)).toEqual({ delta: 600, track: 1 })
    const next = video({ id: 'n', start: 2_000, duration: 1_000 })
    const row = [follower, next, video({ id: 'z', start: 6_000, duration: 1_000 })]
    expect(shifted(row, next, ['f'], 1_500, 0)).toEqual({ delta: 1_500, track: 0 })
  })

  it('被抓的片段换到有时间重叠的同伴的那一行：不许换，留在自己那一行挪', () => {
    expect(shifted(videos, grabbed, ['f'], 500, 0)).toEqual({ delta: 500, track: 1 })
  })

  it('被抓的片段换到另一行、那里有别的片段挡路：取两边都放得下的最近处', () => {
    expect(shifted(videos, grabbed, ['f'], 1_000, 2)).toEqual({ delta: 500, track: 2 })
  })

  it('被抓的片段新开一行：新的一行上没有别的片段，同伴照样要避让', () => {
    expect(shifted(videos, grabbed, ['f'], 1_500, null)).toEqual({ delta: 1_000, track: null })
  })

  it('被抓的片段要去的行前面都占满了：整组挪到它能接在那一行最后一个片段后面的地方', () => {
    const full = video({ id: 'w', start: 0, duration: 119_500, track: 3 })
    expect(shifted([...videos, full], grabbed, ['f'], 500, 3)).toEqual({
      delta: 118_500,
      track: 3,
    })
  })

  it('整组往前顶到 0：最靠前的片段停在 0', () => {
    const late = video({ id: 'l', start: 4_000, duration: 1_000, track: 1 })
    const early = video({ id: 'e', start: 800, duration: 1_000, track: 2 })
    expect(shifted([late, early], late, ['e'], -3_000, 1)).toEqual({ delta: -800, track: 1 })
  })

  it('同伴是音频片段：它只避让声音区同号那一行上的片段，画面区同号的行不挡它', () => {
    // f 在画面区第 0 行；选中的音频片段 s 在声音区第 0 行，后面有没选中的音频片段 q
    const sound = audio({ id: 's', start: 0, duration: 1_000 })
    const queued = audio({ id: 'q', start: 2_500, duration: 1_000 })
    const film = [...videos, sound, queued]
    // 挪 1 秒：s 到 1–2 秒，不碰 q；画面区第 0 行的 o（3–5 秒）不挡 s
    expect(shifted(film, grabbed, ['s'], 1_000, 1)).toEqual({ delta: 1_000, track: 1 })
    // 想挪 2 秒：s 会压到 q，整组退到 s 刚好接在 q 前面
    expect(shifted(film, grabbed, ['s'], 2_000, 1)).toEqual({ delta: 1_500, track: 1 })
  })

  it('被抓的音频片段换到声音区的另一行：只看那一行的音频片段，画面区同号的行不挡路', () => {
    const sound = audio({ id: 's', start: 0, duration: 1_000 })
    const other = audio({ id: 'q', start: 4_000, duration: 1_000, track: 1 })
    // 声音区第 1 行只有 q（4–5 秒）；画面区第 1 行的 g（1–2 秒）不挡
    expect(shifted([...videos, sound, other], sound, [], 1_000, 1)).toEqual({
      delta: 1_000,
      track: 1,
    })
  })

  it('整组往后挪：final-cut 多长都行', () => {
    const end = video({ id: 'l', start: 110_000, duration: 5_000, track: 1 })
    const head = video({ id: 'e', start: 100_000, duration: 1_000, track: 2 })
    expect(shifted([end, head], head, ['l'], 20_000, 2)).toEqual({ delta: 20_000, track: 2 })
  })
})

describe('挪字幕、字幕和别的片段一起挪', () => {
  // 字幕那一行：0–1 秒、3–4 秒两句；画面区第 0 行同一时间有视频片段
  const early = caption({ id: 'cap-a', start: 0, duration: 1_000 })
  const late = caption({ id: 'cap-b', start: 3_000, duration: 1_000 })
  const shot = video({ id: 'v', start: 0, duration: 4_000 })
  const clips = [early, late, shot]

  it('字幕碰到同一行的别的字幕就停：落在最近的空处；视频片段不挡它', () => {
    expect(shifted(clips, early, [], 2_500, 0)).toEqual({ delta: 2_000, track: 0 })
    expect(shifted(clips, early, [], 1_200, 0)).toEqual({ delta: 1_200, track: 0 })
  })

  it('和视频片段一起挪：各自只避让自己那一行，挪同一个时间差', () => {
    const lone = video({ id: 'w', start: 0, duration: 1_000, track: 1 })
    expect(shifted([...clips, lone], lone, ['cap-a'], 2_500, 1)).toEqual({
      delta: 2_000,
      track: 1,
    })
  })
})

describe('拖一个片段时一起动的片段', () => {
  const line = caption({ id: 'cap-a', start: 0, duration: 1_000 })
  const other = caption({ id: 'cap-b', start: 2_000, duration: 1_000 })
  const shot = video({ id: 'v', start: 0, duration: 2_000, link: 'lk-1' })
  const voice = audio({ id: 'a', start: 0, duration: 2_000, link: 'lk-1' })
  const clips = [line, other, shot, voice]
  const selected = new Set(['cap-a', 'cap-b', 'v'])

  it('不在多选里：只有它自己（和联动的伙伴）', () => {
    expect(editGroup(line, new Set(['v']), clips, 'move')).toEqual(new Set(['cap-a']))
    expect(editGroup(shot, new Set(), clips, 'end')).toEqual(new Set(['v', 'a']))
  })

  it('挪动：整个选中一起挪，联动的伙伴跟着', () => {
    expect(editGroup(line, selected, clips, 'move')).toEqual(new Set(['cap-a', 'cap-b', 'v', 'a']))
  })

  it('裁剪只裁同类的：拖字幕时只有选中的字幕，拖别的片段时选中的字幕不跟着', () => {
    expect(editGroup(line, selected, clips, 'start')).toEqual(new Set(['cap-a', 'cap-b']))
    expect(editGroup(shot, selected, clips, 'end')).toEqual(new Set(['v', 'a']))
  })
})

describe('成组裁剪', () => {
  // 第一行：相邻的 l、r，后面隔开的 n；第二行：u
  const left = video({ id: 'l', start: 0, duration: 2_000, mediaStart: 500, src: 'l.mp4' })
  const right = video({ id: 'r', start: 2_000, duration: 2_000, src: 'r.mp4' })
  const next = video({ id: 'n', start: 6_000, duration: 1_000, src: 'n.mp4' })
  const upper = video({
    id: 'u',
    start: 1_000,
    duration: 2_000,
    mediaStart: 1_000,
    src: 'u.mp4',
    track: 1,
  })
  const videos = [left, right, next, upper]
  const sources = new Map([
    ['l.mp4', 10_000],
    ['r.mp4', 3_000],
    ['n.mp4', 10_000],
    ['u.mp4', 5_000],
  ])
  const known = (clip: FilmClip) => sources.get(srcOf(clip))

  /** 一起裁完以后的 final-cut；先检查三条，再按片段给出各自的起止和入点。 */
  const trimmedGroup = (
    members: readonly FilmClip[],
    edge: 'start' | 'end',
    delta: number,
    sourceMs = known,
  ) => {
    const timings = groupTrimmed(members, edge, delta, videos, sourceMs)
    expectValidFilm(videos.map((clip) => ({ ...clip, ...timings.get(clip.id) })))
    return Object.fromEntries(timings) as Record<string, Timing>
  }

  it('同一行相邻的两个一起裁结尾：往外拉被后一个片段挡住，往里收两个一起收', () => {
    expect(groupTrimRange([left, right], 'end', videos, known)).toEqual({ min: -1_900, max: 0 })
    expect(trimmedGroup([left, right], 'end', 500)).toEqual({
      l: { start: 0, duration: 2_000, mediaStart: 500 },
      r: { start: 2_000, duration: 2_000, mediaStart: 0 },
    })
    expect(trimmedGroup([left, right], 'end', -500)).toEqual({
      l: { start: 0, duration: 1_500, mediaStart: 500 },
      r: { start: 2_000, duration: 1_500, mediaStart: 0 },
    })
  })

  it('同一行相邻的两个一起裁开头：往前拉被前一个片段挡住，往后收起点和入点一起动', () => {
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

  it('有一个片段的素材总长还没读到：结尾不能往外拉，往里收照样可以', () => {
    const unread = (clip: FilmClip) => (srcOf(clip) === 'u.mp4' ? undefined : known(clip))
    expect(trimmedGroup([right, upper], 'end', 1_000, unread)).toEqual({
      r: { start: 2_000, duration: 2_000, mediaStart: 0 },
      u: { start: 1_000, duration: 2_000, mediaStart: 1_000 },
    })
    expect(trimmedGroup([right, upper], 'end', -500, unread)).toEqual({
      r: { start: 2_000, duration: 1_500, mediaStart: 0 },
      u: { start: 1_000, duration: 1_500, mediaStart: 1_000 },
    })
  })

  it('三种片段一起裁：同一个量，按最受限的那个收住；组件或块的片段从第几秒开始播跟着动，结尾不受长度限制', () => {
    // 画面区第 0 行：视频片段 p（1–3 秒，入点 0.5 秒，素材 4 秒）；第 1 行：组件或块的片段 k（1–3 秒，从第 0.3 秒播）；
    // 声音区第 0 行：音频片段 a（2–3 秒，入点 1 秒，音频 2.5 秒）
    const shot = video({ id: 'p', start: 1_000, duration: 2_000, mediaStart: 500, src: 'p.mp4' })
    const title = host({
      id: 'k',
      start: 1_000,
      duration: 2_000,
      playbackStart: 300,
      track: 1,
    })
    const music = audio({ id: 'a', start: 2_000, duration: 1_000, mediaStart: 1_000, src: 'a.mp3' })
    const clips = [shot, title, music]
    const lengths = new Map([
      ['p.mp4', 4_000],
      ['a.mp3', 2_500],
    ])
    const lengthOf = (clip: FilmClip) => lengths.get(srcOf(clip))
    const together = (edge: 'start' | 'end', delta: number) => {
      const timings = groupTrimmed(clips, edge, delta, clips, lengthOf)
      expectValidFilm(clips.map((clip) => ({ ...clip, ...timings.get(clip.id) })))
      return Object.fromEntries(timings) as Record<string, Timing>
    }
    // 开头往前拉 1 秒：组件或块的片段只能往前 0.3 秒（视频片段 0.5 秒、音频片段 1 秒）
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
    // 结尾往后拉 5 秒：音频只剩 0.5 秒（视频片段还能拉 1.5 秒，组件或块的片段不限）
    expect(together('end', 5_000)).toEqual({
      p: { start: 1_000, duration: 2_500, mediaStart: 500 },
      k: { start: 1_000, duration: 2_500, mediaStart: 300 },
      a: { start: 2_000, duration: 1_500, mediaStart: 1_000 },
    })
  })

  it('只有一个片段：和单独裁它一样', () => {
    for (const [edge, timeMs] of [
      ['start', 1_200],
      ['start', -1_000],
      ['end', 9_000],
      ['end', 2_050],
    ] as const) {
      const edgeMs = edge === 'start' ? upper.start : upper.start + upper.duration
      expect(trimmedGroup([upper], edge, timeMs - edgeMs)['u']).toEqual(
        trimmed(upper, edge, timeMs, trimBounds(upper, edge, videos, known(upper))),
      )
    }
  })
})

describe('合拢空档', () => {
  it('点在两个片段之间的空档上：它后面这一行的片段都往前挪这个空档的宽度', () => {
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

  it('点在片段上，或者点在最后一个片段后面：没有这一个空档可合拢', () => {
    expect(gapClosing(film, VISUAL_0, 1_000).one.size).toBe(0)
    expect(gapClosing(film, VISUAL_0, 9_000).one.size).toBe(0)
  })

  it('这一行没有空档：两种都没有可挪的；开头的空也算空档', () => {
    const tight = [first, video({ id: 'e', start: 2_000, duration: 1_000 })]
    expect(gapClosing(tight, VISUAL_0, 5_000).all.size).toBe(0)
    expect([...gapClosing(film, { zone: 'visual', track: 1 }, 500).one]).toEqual([['d', 0]])
  })

  it('只合拢这个区这一行的片段：声音区第 0 行和画面区第 0 行各算各的', () => {
    const music = audio({ id: 'm', start: 4_000, duration: 1_000 })
    expect([...gapClosing([...film, music], { zone: 'audio', track: 0 }, 1_000).one]).toEqual([
      ['m', 0],
    ])
    expect([...gapClosing([...film, music], VISUAL_0, 2_500).all]).toEqual([
      ['b', 2_000],
      ['c', 4_000],
    ])
  })

  it('字幕那一行不合拢：两种都没有可挪的', () => {
    const lines = [caption({ start: 1_000 }), caption({ id: 'cap-b2', start: 5_000 })]
    expect(gapClosing(lines, { zone: 'caption', track: 0 }, 4_000)).toEqual({
      one: new Map(),
      all: new Map(),
    })
  })
})

describe('波纹编辑', () => {
  it('删掉第一行的片段：它后面第一行的片段往前补上它的长度，别的行不动', () => {
    expect([...rippleStarts(film, new Set(['a']))]).toEqual([
      ['b', 1_000],
      ['c', 4_000],
    ])
  })

  it('一次删几个：每个片段挪的是它前面被删掉的总长', () => {
    expect([...rippleStarts(film, new Set(['a', 'b']))]).toEqual([['c', 2_000]])
  })

  it('删的不是第一行的片段：谁都不动', () => {
    expect(rippleStarts(film, new Set(['d'])).size).toBe(0)
  })

  it('第一行是最上面那一行，行号不一定是 0', () => {
    const lowered = film.map((clip) => ({ ...clip, track: clip.track + 3 }))
    expect([...rippleStarts(lowered, new Set(['a']))]).toEqual([
      ['b', 1_000],
      ['c', 4_000],
    ])
    expect(rippleStarts(lowered, new Set(['d'])).size).toBe(0)
  })

  it('主轨是画面区最上面那一行：组件或块的片段在那一行就跟着补；音频片段行号再小也不算', () => {
    const title = host({ id: 'k', start: 7_000, duration: 1_000, track: 2 })
    const raised = [...film.map((clip) => ({ ...clip, track: clip.track + 2 })), title]
    const music = audio({ id: 'm', start: 3_000, duration: 1_000, track: 0 })
    expect([...rippleStarts([...raised, music], new Set(['a']))]).toEqual([
      ['b', 1_000],
      ['c', 4_000],
      ['k', 5_000],
    ])
    expect(rippleStarts([...raised, music], new Set(['m'])).size).toBe(0)
  })
})

describe('切开', () => {
  const NO_LINKS: Links = new Map()
  const handwritten: FilmClip = {
    kind: 'other',
    id: 'o',
    label: '手写文字',
    start: 0,
    duration: 2_000,
    track: 2,
    hidden: false,
    link: null,
    z: 0,
  }

  it('2 倍速的视频片段（1–7 秒）在 3 秒处切：前半段时长 2、入点不变，后半段从 3 秒起、时长 4、入点 4 秒', () => {
    const fast = video({ id: 'v', start: 1_000, duration: 6_000, playbackRate: 2 })
    expect(splitAt(fast, 3_000, [fast], NO_LINKS)).toEqual({
      cuts: [
        {
          id: 'v',
          first: { start: 1_000, duration: 2_000, mediaStart: 0 },
          second: { start: 3_000, duration: 4_000, mediaStart: 4_000 },
        },
      ],
    })
  })

  it('贴片、场景片段的入点是从组件自己的第几毫秒开始播；音频片段按入点接着算；切点取整到毫秒', () => {
    const title = host({ id: 't', start: 1_000, duration: 3_000, playbackStart: 500 })
    expect(splitAt(title, 2_500.4, [title], NO_LINKS)).toEqual({
      cuts: [
        {
          id: 't',
          first: { start: 1_000, duration: 1_500, mediaStart: 500 },
          second: { start: 2_500, duration: 1_500, mediaStart: 2_000 },
        },
      ],
    })
    const music = audio({ id: 'm', start: 0, duration: 4_000, mediaStart: 10_000 })
    expect(splitAt(music, 1_000, [music], NO_LINKS)).toMatchObject({
      cuts: [{ second: { start: 1_000, duration: 3_000, mediaStart: 11_000 } }],
    })
  })

  it('切点离两端不到最短片段长度（0.1 秒）、或者不在片段里：不切，说明是哪种', () => {
    const clip = video({ id: 'v', start: 1_000, duration: 2_000 })
    expect(splitAt(clip, 1_099, [clip], NO_LINKS)).toEqual({ refusal: 'edge' })
    expect(splitAt(clip, 2_901, [clip], NO_LINKS)).toEqual({ refusal: 'edge' })
    expect(splitAt(clip, 1_000, [clip], NO_LINKS)).toEqual({ refusal: 'outside' })
    expect(splitAt(clip, 3_500, [clip], NO_LINKS)).toEqual({ refusal: 'outside' })
    expect(splitAt(clip, 1_100, [clip], NO_LINKS)).toHaveProperty('cuts')
    expect(splitAt(clip, 2_900, [clip], NO_LINKS)).toHaveProperty('cuts')
    expect(SPLIT_REFUSAL_TEXT.edge).toBe(
      '播放头离片段两端不足 0.1 秒，无法切开；请把播放头移到片段里面',
    )
  })

  it('切出来的两半都不短于最短片段长度：之后裁开头时能到的范围不颠倒', () => {
    const before = video({ id: 'a', start: 0, duration: 2_000 })
    const clip = video({ id: 'b', start: 2_000, duration: 2_000 })
    const [cut] = razorSplit(clip, 2_001, [before, clip], NO_LINKS)
    if (cut === undefined) throw new Error('没有切开')
    const head = { ...clip, ...cut.first }
    const tail = video({ id: 'c', ...cut.second })
    const clips = [before, head, tail]
    for (const half of [head, tail]) {
      expect(half.duration).toBeGreaterThanOrEqual(MIN_CLIP_MS)
      const bounds = trimBounds(half, 'start', clips, 6_000)
      expect(bounds.min).toBeLessThanOrEqual(bounds.max)
    }
  })

  it('「其他」片段和字幕不切；按着 Shift 用剃刀点时也跳过字幕', () => {
    const line = caption({ start: 0, duration: 2_000 })
    const shot = video({ id: 'v', start: 0, duration: 2_000 })
    for (const clip of [handwritten, line]) {
      expect(splitAt(clip, 1_000, [clip], NO_LINKS)).toEqual({ refusal: 'kind' })
      expect(razorSplit(clip, 1_000, [clip], NO_LINKS)).toEqual([])
    }
    expect(splitAllAt(1_000, [shot, line], NO_LINKS).map((cut) => cut.id)).toEqual(['v'])
  })

  it('链接的一对在同一处一起切；链接的片段离端点太近时整个不切', () => {
    const picture = video({ id: 'v', start: 0, duration: 4_000, mediaStart: 1_000 })
    const sound = audio({ id: 'a', start: 500, duration: 3_500, mediaStart: 1_500 })
    const clips = [picture, sound]
    const links: Links = new Map([
      ['v', 'lk-1'],
      ['a', 'lk-1'],
    ])
    expect(splitAt(picture, 2_000, clips, links)).toEqual({
      cuts: [
        {
          id: 'v',
          first: { start: 0, duration: 2_000, mediaStart: 1_000 },
          second: { start: 2_000, duration: 2_000, mediaStart: 3_000 },
        },
        {
          id: 'a',
          first: { start: 500, duration: 1_500, mediaStart: 1_500 },
          second: { start: 2_000, duration: 2_000, mediaStart: 3_000 },
        },
      ],
    })
    expect(splitAt(picture, 510, clips, links)).toEqual({ refusal: 'partner' })
    expect(razorSplit(picture, 510, clips, links)).toEqual([])
  })

  it('在播放头处切：没选中、选中了多个都不切；只有一个时照 splitAt', () => {
    const one = video({ id: 'a', start: 0, duration: 2_000 })
    const two = video({ id: 'b', start: 2_000, duration: 2_000 })
    expect(playheadSplit([], 1_000, [one, two], NO_LINKS)).toEqual({ refusal: 'none' })
    expect(playheadSplit([one, two], 1_000, [one, two], NO_LINKS)).toEqual({ refusal: 'many' })
    expect(playheadSplit([two], 1_000, [one, two], NO_LINKS)).toEqual({ refusal: 'outside' })
    expect(playheadSplit([one], 1_000, [one, two], NO_LINKS)).toEqual(
      splitAt(one, 1_000, [one, two], NO_LINKS),
    )
  })

  it('剃刀点得太靠边：夹进离两端 0.1 秒处切；片段短得夹不进时不切', () => {
    const clip = video({ id: 'v', start: 1_000, duration: 2_000 })
    expect(razorSplit(clip, 1_005, [clip], NO_LINKS)).toMatchObject([
      { first: { duration: 100 }, second: { start: 1_100 } },
    ])
    expect(razorSplit(clip, 2_999, [clip], NO_LINKS)).toMatchObject([
      { first: { duration: 1_900 }, second: { start: 2_900, duration: 100 } },
    ])
    const tiny = video({ id: 't', start: 0, duration: 150 })
    expect(razorSplit(tiny, 75, [tiny], NO_LINKS)).toEqual([])
  })

  it('按着 Shift 点：在那个时间切开所有能切的片段，链接的片段只切一次，切不了的跳过', () => {
    const picture = video({ id: 'v', start: 0, duration: 4_000 })
    const sound = audio({ id: 'a', start: 0, duration: 4_000 })
    const title = host({ id: 't', start: 1_990, duration: 1_000, track: 1 })
    const later = video({ id: 'l', start: 4_000, duration: 1_000 })
    const clips = [picture, sound, title, later, handwritten]
    const links: Links = new Map([
      ['v', 'lk-1'],
      ['a', 'lk-1'],
    ])
    expect(splitAllAt(2_000, clips, links).map((cut) => cut.id)).toEqual(['v', 'a'])
    expect(splitAllAt(2_100, clips, links).map((cut) => cut.id)).toEqual(['v', 'a', 't'])
  })
})

describe('联动', () => {
  // 视频 2–4 秒、入点 1 秒；分离出来的原声同样的起止、入点，和它联动着；原声那一行 5 秒处有一条配乐
  const shot = video({ id: 'v', start: 2_000, duration: 2_000, mediaStart: 1_000, link: 'lk-1' })
  const voice = audio({ id: 'a', start: 2_000, duration: 2_000, mediaStart: 1_000, link: 'lk-1' })
  const music = audio({ id: 'm', start: 5_000, duration: 2_000 })
  const pair = [shot, voice, music]
  const ONE = new Set(['v'])
  const plenty = () => 10_000

  it('挪动时联动的伙伴一起挪；联动关着时只有自己', () => {
    expect(linkedGroup(ONE, pair, 'move')).toEqual(new Set(['v', 'a']))
    const unlinked = [shot, { ...voice, link: null }, music]
    expect(linkedGroup(ONE, unlinked, 'move')).toEqual(ONE)
    expect(linkedPartners(['a'], pair)).toEqual(['v'])
    expect(linkedPartners(['a', 'v'], pair)).toEqual([])
    expect(linkedPartners(['m'], pair)).toEqual([])
  })

  it('一起挪：伙伴在自己那一行放不下时整对停住（和多选一起挪一样）', () => {
    const group = linkedGroup(ONE, pair, 'move')
    // 想往后挪 2 秒：原声会压到 5 秒处的配乐，整对停在原声贴着配乐的地方
    expect(shifted(pair, shot, [...group], 2_000, 0).delta).toBe(1_000)
    // 往前挪到 0 秒以前：整对停在 0
    expect(shifted(pair, shot, [...group], -5_000, 0).delta).toBe(-2_000)
  })

  it('裁一端：这一端原来对齐的伙伴跟着裁，没对齐的不跟', () => {
    const longer = { ...voice, duration: 2_500 }
    expect(linkedGroup(ONE, [shot, longer], 'end')).toEqual(ONE)
    expect(linkedGroup(ONE, [shot, longer], 'start')).toEqual(new Set(['v', 'a']))
    const later = { ...voice, start: 2_300, duration: 1_700, mediaStart: 1_300 }
    expect(linkedGroup(ONE, [shot, later], 'start')).toEqual(ONE)
    expect(linkedGroup(ONE, [shot, later], 'end')).toEqual(new Set(['v', 'a']))
  })

  it('一起裁开头：伙伴的入点跟着变，裁完口型不乱', () => {
    const members = pair.filter((clip) => linkedGroup(ONE, pair, 'start').has(clip.id))
    const timings = groupTrimmed(members, 'start', 500, pair, plenty)
    expect(timings).toEqual(
      new Map([
        ['v', { start: 2_500, duration: 1_500, mediaStart: 1_500 }],
        ['a', { start: 2_500, duration: 1_500, mediaStart: 1_500 }],
      ]),
    )
  })

  it('合拢空档、波纹补位：伙伴挪同样的时间差，自己也在表里时按自己的，不早于 0', () => {
    expect(withLinkedStarts(new Map([['v', 1_000]]), pair)).toEqual(
      new Map([
        ['v', 1_000],
        ['a', 1_000],
      ]),
    )
    expect(
      withLinkedStarts(
        new Map([
          ['v', 1_000],
          ['a', 1_500],
        ]),
        pair,
      ),
    ).toEqual(
      new Map([
        ['v', 1_000],
        ['a', 1_500],
      ]),
    )
    const earlier = [shot, { ...voice, start: 500, mediaStart: 0 }]
    expect(withLinkedStarts(new Map([['v', 0]]), earlier).get('a')).toBe(0)
  })

  it('「原片截取」上只拖出点：结尾对齐的伙伴一起裁', () => {
    const end = { start: 2_000, duration: 1_500, mediaStart: 1_000 }
    expect(sourceTrimmed(shot, end, pair, plenty)).toEqual(
      new Map([
        ['v', end],
        ['a', end],
      ]),
    )
  })

  it('「原片截取」上改入点、换一截素材：计时完全一样的伙伴做同样的改动，不一样的只改自己', () => {
    const inPoint = { start: 2_000, duration: 1_800, mediaStart: 1_200 }
    const both = new Map([
      ['v', inPoint],
      ['a', inPoint],
    ])
    expect(sourceTrimmed(shot, inPoint, pair, plenty)).toEqual(both)
    const body = { start: 2_000, duration: 2_000, mediaStart: 3_000 }
    expect(sourceTrimmed(voice, body, pair, plenty)).toEqual(
      new Map([
        ['a', body],
        ['v', body],
      ]),
    )
    // 开始、时长、入点、速度有一样不同：只改自己
    for (const differs of [
      { start: 2_100, mediaStart: 1_100, duration: 1_900 },
      { duration: 1_500 },
      { mediaStart: 900 },
      { playbackRate: 1.5 },
    ]) {
      const film = [shot, { ...voice, ...differs }, music]
      expect(sourceTrimmed(shot, inPoint, film, plenty)).toEqual(new Map([['v', inPoint]]))
    }
    // 联动关着：只改自己
    const unlinked = [shot, { ...voice, link: null }, music]
    expect(sourceTrimmed(shot, inPoint, unlinked, plenty)).toEqual(new Map([['v', inPoint]]))
  })

  it('改入点让两段都往后延时，按挡得最紧的那一行收住，出点不动', () => {
    // 原声那一行 4.5 秒处有片段；视频想从入点 0 起放到 5 秒
    const blocked = [shot, voice, { ...music, start: 4_500 }]
    const longer = { start: 2_000, duration: 3_000, mediaStart: 0 }
    const capped = { start: 2_000, duration: 2_500, mediaStart: 500 }
    expect(sourceTrimmed(shot, longer, blocked, plenty)).toEqual(
      new Map([
        ['v', capped],
        ['a', capped],
      ]),
    )
  })
})
