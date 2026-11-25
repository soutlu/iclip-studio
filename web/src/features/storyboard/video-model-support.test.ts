import { describe, expect, it } from 'vitest'
import { orderVideoModels, supportsAspectRatio, videoModelShortName } from './video-model-support'

describe('视频模型短名、顺序与画幅', () => {
  it.each([
    ['wan3.0-video-prime', 'wan3'],
    ['mmt-seedance-2-5-flash', 'sd2.5flash'],
    ['mmt-seedance-2-5', 'sd2.5'],
    ['wan3.0-video', 'wan3'],
    ['vendor-a-seedance-2-5-flash', 'sd2.5flash'],
    ['vendor-a-seedance-2-5', 'sd2.5'],
    ['seedance_2.0', 'seedance_2.0'],
  ])('%s 显示为 %s', (model, shortName) => {
    expect(videoModelShortName(model)).toBe(shortName)
  })

  it('按 wan3 · sd2.5flash · sd2.5 排列，不认识的排在最后、彼此保持原顺序', () => {
    expect(
      orderVideoModels([
        'seedance_2.0',
        'mmt-seedance-2-5',
        'other-model',
        'mmt-seedance-2-5-flash',
        'wan3.0-video-prime',
      ]),
    ).toEqual([
      'wan3.0-video-prime',
      'mmt-seedance-2-5-flash',
      'mmt-seedance-2-5',
      'seedance_2.0',
      'other-model',
    ])
  })

  it('没有 wan3 时只剩两个，相对顺序不变', () => {
    expect(orderVideoModels(['vendor-a-seedance-2-5', 'vendor-a-seedance-2-5-flash'])).toEqual([
      'vendor-a-seedance-2-5-flash',
      'vendor-a-seedance-2-5',
    ])
  })

  it('只有 wan3 不支持 21:9', () => {
    expect(supportsAspectRatio('wan3.0-video', '21:9')).toBe(false)
    expect(supportsAspectRatio('wan3.0-video', '16:9')).toBe(true)
    for (const model of ['vendor-a-seedance-2-5-flash', 'vendor-a-seedance-2-5', 'seedance_2.0'])
      expect(supportsAspectRatio(model, '21:9')).toBe(true)
  })
})
