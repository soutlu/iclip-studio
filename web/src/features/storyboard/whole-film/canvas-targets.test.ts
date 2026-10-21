import { describe, expect, it } from 'vitest'
import { card, draftOf, overlay, video } from '@/testing/whole-film'
import { captionKey, hfIdOnScreen, selectionOfHfId } from './canvas-targets'
import type { PlacedCaption } from './composition/captions'

const placed = (clipId: string, sentenceIndex: number, start: number, end: number) =>
  ({
    clipId,
    subtitleJobId: 'sub1',
    sentenceIndex,
    start,
    end,
    text: '口播',
    words: [],
  }) satisfies PlacedCaption

// 视频段 0–3 秒、组件段 3–5 秒；特效块 1–2 秒
const DRAFT = draftOf([video('v1', 'job', 0, 3_000), card('c1', 2_000)], {
  overlays: [overlay('o1', 1_000, 1_000)],
})
const CAPTIONS = [placed('v1', 0, 0, 1_200), placed('v1', 1, 1_500, 2_800)]

describe('selectionOfHfId', () => {
  it('草稿里的段、特效块按 id 认出；caption:N 是第 N 份字幕，记成它的身份而不是下标', () => {
    expect(selectionOfHfId('v1', DRAFT, CAPTIONS)).toEqual({ kind: 'clip', id: 'v1' })
    expect(selectionOfHfId('c1', DRAFT, CAPTIONS)).toEqual({ kind: 'clip', id: 'c1' })
    expect(selectionOfHfId('o1', DRAFT, CAPTIONS)).toEqual({ kind: 'overlay', id: 'o1' })
    expect(selectionOfHfId('caption:1', DRAFT, CAPTIONS)).toEqual({
      kind: 'caption',
      key: captionKey(CAPTIONS[1] as PlacedCaption),
    })
  })

  it('组件自带的、对不上当前草稿与字幕的 data-hf-id 认不出', () => {
    for (const hfId of ['hf-123', 'caption:2', 'caption:', 'caption:1x', 'caption:-1'])
      expect(selectionOfHfId(hfId, DRAFT, CAPTIONS)).toBeUndefined()
  })
})

describe('hfIdOnScreen', () => {
  it('选中的一块在这一刻的时间范围里才给出它的 data-hf-id', () => {
    expect(hfIdOnScreen({ kind: 'clip', id: 'v1' }, DRAFT, CAPTIONS, 0)).toBe('v1')
    expect(hfIdOnScreen({ kind: 'clip', id: 'v1' }, DRAFT, CAPTIONS, 3_000)).toBeUndefined()
    expect(hfIdOnScreen({ kind: 'clip', id: 'c1' }, DRAFT, CAPTIONS, 3_000)).toBe('c1')
    expect(hfIdOnScreen({ kind: 'overlay', id: 'o1' }, DRAFT, CAPTIONS, 1_500)).toBe('o1')
    expect(hfIdOnScreen({ kind: 'overlay', id: 'o1' }, DRAFT, CAPTIONS, 2_500)).toBeUndefined()
  })

  it('字幕按它现在在成片里的位置给出 caption:N；没选中、选中音乐或已不在草稿里时没有', () => {
    const second = { kind: 'caption', key: captionKey(CAPTIONS[1] as PlacedCaption) } as const
    expect(hfIdOnScreen(second, DRAFT, CAPTIONS, 2_000)).toBe('caption:1')
    expect(hfIdOnScreen(second, DRAFT, CAPTIONS, 1_000)).toBeUndefined()
    expect(hfIdOnScreen(second, DRAFT, [CAPTIONS[1] as PlacedCaption], 2_000)).toBe('caption:0')
    expect(hfIdOnScreen(null, DRAFT, CAPTIONS, 0)).toBeUndefined()
    expect(hfIdOnScreen({ kind: 'music' }, DRAFT, CAPTIONS, 0)).toBeUndefined()
    expect(hfIdOnScreen({ kind: 'overlay', id: 'gone' }, DRAFT, CAPTIONS, 1_500)).toBeUndefined()
  })
})
