import { describe, expect, it } from 'vitest'
import { draftOf, expectOk, video } from '@/testing/whole-film'
import {
  clearCaptionText,
  setCaptionStyle,
  setCaptionText,
  setCaptionsHidden,
  setCaptionsPosition,
  setCaptionsTransform,
  setCaptionsVariables,
} from './captions'
import { MAX_SCALE } from './draft'

const film = () => draftOf([video('v1', 's1', 0, 3_000)])

describe('改字、字幕样式与字幕开关', () => {
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
    const styled = expectOk(setCaptionStyle(film(), { component: 'other-caption' })).draft
    expect(styled.captions.component).toBe('other-caption')
    expect(expectOk(setCaptionStyle(styled, { component: 'other-caption' })).draft).toBe(styled)
  })

  it('关掉字幕只改开关，样式与改过的字留着；再打开回到开着', () => {
    const edited = expectOk(
      setCaptionText(
        expectOk(setCaptionStyle(film(), { component: 'other-caption' })).draft,
        edit(0, '甲'),
      ),
    ).draft
    const off = expectOk(setCaptionsHidden(edited, { hidden: true })).draft
    expect(off.captions).toEqual({ ...edited.captions, hidden: true })
    const on = expectOk(setCaptionsHidden(off, { hidden: false })).draft
    expect(on.captions).toEqual({ ...edited.captions, hidden: false })
  })

  it('改字幕的可填项：取值没变时原样返回，没写的草稿按没填过算；换样式时留着', () => {
    const unset = film()
    unset.captions = { component: unset.captions.component, edits: unset.captions.edits }
    expect(expectOk(setCaptionsVariables(unset, { variables: {} })).draft).toBe(unset)
    const font = expectOk(setCaptionsVariables(unset, { variables: { font: 'Brand' } })).draft
    expect(font.captions.variables).toEqual({ font: 'Brand' })
    expect(expectOk(setCaptionsVariables(font, { variables: { font: 'Brand' } })).draft).toBe(font)
    const styled = expectOk(setCaptionStyle(font, { component: 'other-caption' })).draft
    expect(styled.captions).toMatchObject({
      component: 'other-caption',
      variables: { font: 'Brand' },
    })
  })

  it('开关没变时原样返回；没写开关的草稿按开着算', () => {
    // 有这个字段之前存的草稿没写 hidden
    const unset = film()
    unset.captions = { component: unset.captions.component, edits: unset.captions.edits }
    expect(expectOk(setCaptionsHidden(unset, { hidden: false })).draft).toBe(unset)
    const off = expectOk(setCaptionsHidden(unset, { hidden: true })).draft
    expect(expectOk(setCaptionsHidden(off, { hidden: true })).draft).toBe(off)
  })

  it('挪字幕：全部字幕共用一个位置，取整并裁在 ±4096 以内', () => {
    const moved = expectOk(setCaptionsPosition(film(), { x: -12.5, y: 300.2 })).draft
    expect(moved.captions).toEqual({ ...film().captions, x: -12, y: 300 })
    const far = expectOk(setCaptionsPosition(film(), { x: -5_000, y: 4_097 })).draft
    expect([far.captions.x, far.captions.y]).toEqual([-4_096, 4_096])
  })

  it('位置没变时原样返回，没写位置的草稿按没挪过算；改字、换样式、开关都保留位置', () => {
    const draft = film()
    expect(expectOk(setCaptionsPosition(draft, { x: 0.2, y: -0.4 })).draft).toBe(draft)
    // 有位置之前存的草稿没写 x、y
    const unset = film()
    unset.captions = { component: unset.captions.component, edits: unset.captions.edits }
    expect(expectOk(setCaptionsPosition(unset, { x: 0, y: 0 })).draft).toBe(unset)

    const moved = expectOk(setCaptionsPosition(draft, { x: 8, y: -40 })).draft
    for (const result of [
      setCaptionText(moved, edit(0, '甲')),
      clearCaptionText(moved, { subtitleJobId: 'sub1', sentenceIndex: 0 }),
      setCaptionStyle(moved, { component: 'other-caption' }),
      setCaptionsHidden(moved, { hidden: true }),
    ]) {
      const { captions } = expectOk(result).draft
      expect([captions.x, captions.y]).toEqual([8, -40])
    }
  })

  it('缩放、旋转字幕：全部字幕共用一套，倍数裁在 10%–1000%、角度规整到 (-180, 180]，转轴在离开原大、不转时记下', () => {
    const turned = expectOk(
      setCaptionsTransform(film(), { scale: 12, rotation: -180, pivot: { x: 540.4, y: 1_700.5 } }),
    ).draft
    expect(turned.captions).toEqual({
      ...film().captions,
      scale: MAX_SCALE,
      rotation: 180,
      pivotX: 540,
      pivotY: 1_701,
    })
    const again = expectOk(
      setCaptionsTransform(turned, { scale: 0.5, rotation: 190, pivot: { x: 0, y: 0 } }),
    ).draft
    expect(again.captions).toMatchObject({ scale: 0.5, rotation: -170, pivotX: 540, pivotY: 1_701 })
  })

  it('倍数与角度都没变时原样返回、转轴不写；改字、换样式、开关、挪位置都保留缩放与旋转', () => {
    const draft = film()
    const pivot = { x: 10, y: 20 }
    expect(expectOk(setCaptionsTransform(draft, { scale: 1, rotation: 0, pivot })).draft).toBe(
      draft,
    )
    // 有这几个字段之前存的草稿没写它们
    const unset = film()
    unset.captions = { component: unset.captions.component, edits: unset.captions.edits }
    expect(expectOk(setCaptionsTransform(unset, { scale: 1, rotation: -360, pivot })).draft).toBe(
      unset,
    )

    const turned = expectOk(setCaptionsTransform(draft, { scale: 0.8, rotation: 15, pivot })).draft
    expect(expectOk(setCaptionsTransform(turned, { scale: 0.8, rotation: 375, pivot })).draft).toBe(
      turned,
    )
    for (const result of [
      setCaptionText(turned, edit(0, '甲')),
      clearCaptionText(turned, { subtitleJobId: 'sub1', sentenceIndex: 0 }),
      setCaptionStyle(turned, { component: 'other-caption' }),
      setCaptionsHidden(turned, { hidden: true }),
      setCaptionsPosition(turned, { x: 8, y: -40 }),
    ]) {
      expect(expectOk(result).draft.captions).toMatchObject({
        scale: 0.8,
        rotation: 15,
        pivotX: 10,
        pivotY: 20,
      })
    }
  })
})
