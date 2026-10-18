import { describe, expect, it } from 'vitest'
import { draftOf, expectOk, video } from '@/testing/whole-film'
import { clearCaptionText, setCaptionStyle, setCaptionText } from './captions'

const film = () => draftOf([video('v1', 's1', 0, 3_000)])

describe('改字与字幕样式', () => {
  const edit = (sentenceIndex: number, text: string) => ({
    subtitleJobId: 'sub1',
    sentenceIndex,
    text,
  })

  it('同一句再改就替换，位置不变；撤掉改字回到识别结果', () => {
    const twice = [edit(0, '甲'), edit(1, '乙'), edit(0, '丙')].reduce(
      (d, e) => expectOk(setCaptionText(d, e)).draft,
      film(),
    )
    expect(twice.captions.edits).toEqual([edit(0, '丙'), edit(1, '乙')])
    const cleared = expectOk(
      clearCaptionText(twice, { subtitleJobId: 'sub1', sentenceIndex: 0 }),
    ).draft
    expect(cleared.captions.edits).toEqual([edit(1, '乙')])
    expect(
      expectOk(clearCaptionText(cleared, { subtitleJobId: 'sub1', sentenceIndex: 0 })).draft,
    ).toBe(cleared)
  })

  it('换字幕样式；同一个样式原样返回', () => {
    const styled = expectOk(setCaptionStyle(film(), { component: 'caption-texture' })).draft
    expect(styled.captions.component).toBe('caption-texture')
    expect(expectOk(setCaptionStyle(styled, { component: 'caption-texture' })).draft).toBe(styled)
  })
})
