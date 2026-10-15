import { assert, describe, expect, it } from 'vitest'
import type { BrandTemplate } from '@/shared/api/brand-templates'
import { brandOf, matchesFilmRatio, templateBlockedReason } from './film-brand'
import {
  brandDuration,
  EMPTY_FILM,
  insertSegment,
  MAX_FILM_SEGMENTS,
  setBrand,
  splitAt,
  trimSegment,
  wholeFilmDuration,
} from './film-draft'
import { wholeFilmBody } from './film-submit'

const template: BrandTemplate = {
  id: 'intro',
  name: '品牌片头',
  position: 'intro',
  url: 'https://media.example/intro.mp4',
  width: 1080,
  height: 1920,
  durationMs: 2000,
  hasAudio: true,
  disabledAt: null,
  createdAt: '2026-10-14T00:00:00Z',
}
const frame = { width: 720, height: 1280 }
const part = { sourceJobId: 'source', start: 0, end: 10 }
const insert = (...args: Parameters<typeof insertSegment>) => {
  const film = insertSegment(...args)
  assert(film !== undefined)
  return film
}
const base = insert(EMPTY_FILM, part, 0, 'first')

describe('片头片尾与合成上限', () => {
  it('按正文第一段实测比例筛选，2% 边界可用，横版与竖版不混用', () => {
    expect(matchesFilmRatio(template, frame)).toBe(true)
    expect(matchesFilmRatio({ width: 102, height: 100 }, { width: 1, height: 1 })).toBe(true)
    expect(matchesFilmRatio({ width: 102.1, height: 100 }, { width: 1, height: 1 })).toBe(false)
    expect(matchesFilmRatio({ width: 1920, height: 1080 }, frame)).toBe(false)
  })
  it('停用或画幅改变时禁止新合成，但保留旧模板快照', () => {
    const film = setBrand(base, 'intro', brandOf(template))
    expect(templateBlockedReason(film, [template], frame)).toBeUndefined()
    expect(templateBlockedReason(film, [], frame)).toContain('片头模板已停用')
    expect(templateBlockedReason(film, [template], { width: 1920, height: 1080 })).toContain(
      '画幅不匹配',
    )
    expect(film.intro?.url).toBe(template.url)
  })
  it('片头片尾各只保留一条，提交模板 ID，字幕和音乐仍从正文零秒起', () => {
    const film = setBrand(setBrand(base, 'intro', brandOf(template)), 'intro', {
      ...brandOf(template),
      templateId: 'replacement',
    })
    const body = wholeFilmBody({
      conversationId: 'c',
      taskId: null,
      film,
      subtitles: [{ at: 0, end: 1, text: '正文' }],
      music: { audioJobId: 'audio', start: 5, curve: [{ atMs: 0, gain: 1 }] },
    })
    expect(brandDuration(film)).toBe(2)
    expect(wholeFilmDuration(film)).toBe(12)
    expect(body.intro).toEqual({ templateId: 'replacement' })
    expect(body.subtitles).toEqual([{ startMs: 0, endMs: 1000, text: '正文' }])
    expect(body.music?.gain).toEqual([{ atMs: 0, gain: 1 }])
  })
  it('插入、拉长正文都将模板时长计入 120 秒', () => {
    const film = setBrand(
      insert(EMPTY_FILM, { ...part, end: 118 }, 0, 'long'),
      'intro',
      brandOf(template),
    )
    expect(insertSegment(film, { ...part, end: 0.2 }, 1, 'extra')).toBeUndefined()
    const trimmed = trimSegment(film, 'long', 'end', 117)
    expect(wholeFilmDuration(trimSegment(trimmed, 'long', 'end', 120))).toBe(120)
  })
  it('100 段后不能再插入或拆分', () => {
    const film = Array.from({ length: MAX_FILM_SEGMENTS }).reduce<typeof base>(
      (state, _, i) => insert(state, { ...part, end: 1 }, i, `s${i}`),
      EMPTY_FILM,
    )
    expect(insertSegment(film, { ...part, end: 0.2 }, 100, 'extra')).toBeUndefined()
    expect(splitAt(film, 0.5, 'split')).toBeUndefined()
  })
})
