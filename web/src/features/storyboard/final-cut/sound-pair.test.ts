import { describe, expect, it } from 'vitest'
import { audio, video } from '@/testing/final-cut'
import {
  detachBlocked,
  detachedVideoChanges,
  mergeBlocked,
  mergedVideoChanges,
  offsetText,
  resyncPlan,
  soundActionFor,
  soundBadgeOf,
  soundPairOf,
  type SoundPair,
} from './sound-pair'

/** 分离过原声的视频片段（2–4 秒、入点 1 秒）和它的原声，联动着、口型同步。 */
const shot = video({
  id: 'v',
  start: 2_000,
  duration: 2_000,
  mediaStart: 1_000,
  muted: true,
  link: 'lk-1',
  syncOrigin: 'lk-1',
})
const voice = audio({
  id: 'a',
  label: 'A · 镜头 1 · 原声',
  src: shot.src,
  start: 2_000,
  duration: 2_000,
  mediaStart: 1_000,
  link: 'lk-1',
  syncOrigin: 'lk-1',
})
const music = audio({ id: 'm', start: 0, duration: 8_000, track: 1 })

const pairOf = (clips: Parameters<typeof soundPairOf>[1], id = 'a'): SoundPair => {
  const clip = clips.find((each) => each.id === id)
  const pair = clip === undefined ? undefined : soundPairOf(clip, clips)
  if (pair === undefined) throw new Error('不成对')
  return pair
}

describe('一对：错开多少、联动没有', () => {
  it('从哪一段找都是同一对；开始和入点一起挪（裁开头）还是同步', () => {
    const film = [shot, voice, music]
    expect(soundPairOf(shot, film)).toEqual({
      video: shot,
      audio: voice,
      linked: true,
      offsetMs: 0,
    })
    expect(soundPairOf(voice, film)).toEqual(soundPairOf(shot, film))
    // 原声裁掉开头 0.5 秒：开始晚 0.5 秒、入点也晚 0.5 秒，素材零点没动
    const trimmedVoice = { ...voice, start: 2_500, duration: 1_500, mediaStart: 1_500 }
    expect(pairOf([shot, trimmedVoice]).offsetMs).toBe(0)
  })

  it('原声单独往后挪 0.4 秒：晚 400 毫秒；往前挪是负的；联动看链接名', () => {
    const late = { ...voice, start: 2_400, link: null }
    expect(pairOf([shot, late])).toMatchObject({ linked: false, offsetMs: 400 })
    expect(pairOf([shot, { ...voice, start: 1_750 }]).offsetMs).toBe(-250)
  })

  it('速度不同时没有一个错开量；速度一样时按素材零点算（开始 − 入点 ÷ 速度）', () => {
    expect(pairOf([shot, { ...voice, playbackRate: 2 }]).offsetMs).toBeNull()
    const fast = { playbackRate: 2 }
    // 两段都是 2 倍速，原声入点晚 1 秒 = 在 final-cut 里早 0.5 秒放到同一处
    expect(
      pairOf([
        { ...shot, ...fast },
        { ...voice, ...fast, mediaStart: 2_000 },
      ]).offsetMs,
    ).toBe(-500)
  })

  it('不是一对：普通音频、没有出处的视频、出处找不到另一种片段', () => {
    expect(soundPairOf(music, [shot, voice, music])).toBeUndefined()
    expect(soundPairOf(video(), [video(), music])).toBeUndefined()
    expect(soundPairOf(voice, [voice, music])).toBeUndefined()
  })

  it('同一个出处有两段原声（只切开了原声）：视频配的是和它重叠最多的那段', () => {
    const head = { ...voice, id: 'a1', duration: 500 }
    const tail = { ...voice, id: 'a2', start: 2_500, duration: 1_500, mediaStart: 1_500 }
    expect(soundPairOf(shot, [shot, head, tail])?.audio.id).toBe('a2')
  })

  it('错开的写法：两位小数，不到 0.01 秒时三位，可换单位', () => {
    expect(offsetText(400)).toBe('+0.40s')
    expect(offsetText(-1_250, ' 秒')).toBe('-1.25 秒')
    expect(offsetText(3)).toBe('+0.003s')
  })
})

describe('分离音频', () => {
  it('有声音、没关原声的视频片段能分离；素材没声音、已关原声时不能并说明原因', () => {
    expect(detachBlocked(video(), false)).toBeUndefined()
    expect(detachBlocked(video(), true)).toBe('该素材没有声音，无法分离音频')
    expect(detachBlocked(video({ muted: true }), false)).toBe(
      '已关闭原声，无法分离音频；请先打开原声',
    )
  })

  it('视频片段关掉原声、去掉声音属性，写上同一个链接名和出处', () => {
    expect(detachedVideoChanges('lk-3')).toEqual({
      muted: 'true',
      'data-has-audio': null,
      'data-volume': null,
      'data-fade-in': null,
      'data-fade-out': null,
      'data-link': 'lk-3',
      'data-sync-origin': 'lk-3',
    })
  })

  it('选中一个视频片段是分离，选中一对里的任何一个是合并回视频，别的不行', () => {
    const film = [shot, voice, music, video({ id: 'w' })]
    const silent = () => false
    expect(soundActionFor([video({ id: 'w' })], film, silent)).toMatchObject({
      kind: 'detach',
      blocked: undefined,
    })
    expect(soundActionFor([shot], film, silent)).toMatchObject({ kind: 'merge' })
    expect(soundActionFor([voice], film, silent)).toMatchObject({ kind: 'merge' })
    expect(soundActionFor([music], film, silent)).toEqual({
      kind: 'none',
      blocked: '只有视频片段可以分离音频',
    })
    expect(soundActionFor([], film, silent).blocked).toBe(
      '尚未选中片段，无法分离音频；请先选中一个视频片段',
    )
    expect(soundActionFor([shot, voice], film, silent).blocked).toBe(
      '选中了多个片段，无法分离音频；请只选中一个片段',
    )
    expect(soundActionFor([video({ id: 'w' })], film, () => true).blocked).toBe(
      '该素材没有声音，无法分离音频',
    )
  })
})

describe('合并回视频', () => {
  it('同步、隐藏状态一样、视频关着原声时能合并', () => {
    expect(mergeBlocked(pairOf([shot, voice]))).toBeUndefined()
  })

  it('错开、倍速不同、隐藏状态不一样、视频打开了原声时不能合并', () => {
    expect(mergeBlocked(pairOf([shot, { ...voice, start: 2_400 }]))).toBe(
      '原声和画面没对齐，请先对齐口型',
    )
    expect(mergeBlocked(pairOf([shot, { ...voice, playbackRate: 1.5 }]))).toBe(
      '原声和画面的倍速不同，无法合并；请先调成相同的倍速',
    )
    expect(mergeBlocked(pairOf([shot, { ...voice, hidden: true }]))).toBe(
      '原声已静音、画面未隐藏，无法合并；请先取消原声的静音',
    )
    expect(mergeBlocked(pairOf([{ ...shot, hidden: true }, voice]))).toBe(
      '画面已隐藏、原声未静音，无法合并；请先显示画面',
    )
    expect(mergeBlocked(pairOf([{ ...shot, muted: false }, voice]))).toBe(
      '画面已打开原声，无法合并；请先关闭画面的原声',
    )
  })

  it('原声上的声音属性写回视频片段，打开原声，去掉链接名和出处', () => {
    expect(
      mergedVideoChanges({ 'data-volume': '0.5', 'data-fade-in': '0.3', src: 'x', loop: '' }),
    ).toEqual({
      'data-volume': '0.5',
      'data-fade-in': '0.3',
      'data-fade-out': null,
      muted: null,
      'data-has-audio': 'true',
      'data-link': null,
      'data-sync-origin': null,
    })
  })
})

describe('对齐口型', () => {
  it('只挪原声的开始，挪到素材零点和画面重合的地方', () => {
    const late = { ...voice, start: 2_400, link: null }
    expect(resyncPlan(pairOf([shot, late, music]), [shot, late, music])).toEqual({
      start: 2_000,
      displaced: false,
    })
    // 原声裁过开头（入点晚 0.5 秒）：对齐后开始在 2.5 秒
    const trimmedLate = { ...voice, start: 3_100, duration: 1_000, mediaStart: 1_500 }
    expect(resyncPlan(pairOf([shot, trimmedLate]), [shot, trimmedLate])).toEqual({
      start: 2_500,
      displaced: false,
    })
  })

  it('落点被同一行别的片段占着：放到最近的空位，并说明挪开了', () => {
    const late = { ...voice, start: 5_000 }
    const blocker = audio({ id: 'b', start: 1_000, duration: 2_000 })
    const film = [shot, late, blocker]
    expect(resyncPlan(pairOf(film), film)).toEqual({ start: 3_000, displaced: true })
  })

  it('会挪到 0 秒之前、两段倍速不同时对不了', () => {
    // 画面入点 1 秒、从 0.5 秒开始：素材零点在 -0.5 秒，原声入点 0 时得从 -0.5 秒开始
    const early = { ...shot, start: 500 }
    const fromZero = { ...voice, start: 3_000, mediaStart: 0 }
    expect(resyncPlan(pairOf([early, fromZero]), [early, fromZero])).toEqual({
      refusal: '对齐后原声会早于 0 秒，无法对齐口型',
    })
    const faster = { ...voice, playbackRate: 2 }
    expect(resyncPlan(pairOf([shot, faster]), [shot, faster])).toEqual({
      refusal: '原声和画面的倍速不同，无法对齐口型',
    })
  })
})

describe('时间线上原声的小标', () => {
  it('静音时「静音」，错开时「错开 +0.40s」，同步且联动时「联动」，都不是时没有', () => {
    expect(soundBadgeOf(voice, [shot, voice])).toEqual({ text: '联动', tone: 'linked' })
    const late = { ...voice, start: 2_400 }
    expect(soundBadgeOf(late, [shot, late])).toEqual({ text: '错开 +0.40s', tone: 'offset' })
    const muted = { ...late, hidden: true }
    expect(soundBadgeOf(muted, [shot, muted])).toEqual({ text: '静音', tone: 'muted' })
    const unlinked = { ...voice, link: null }
    expect(soundBadgeOf(unlinked, [{ ...shot, link: null }, unlinked])).toBeUndefined()
    expect(soundBadgeOf(music, [shot, voice, music])).toBeUndefined()
    expect(soundBadgeOf(shot, [shot, voice])).toBeUndefined()
  })
})
