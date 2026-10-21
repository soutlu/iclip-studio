import { describe, expect, it } from 'vitest'
import { MAX_VOLUME } from './editing/draft'
import { faderToGain, gainText, gainToFader, stepGain } from './volume-fader'

describe('音量推子（同 HyperFrames）', () => {
  it('0 dB 在正中，最右 +12 dB，最左静音，往左到 −60 dB', () => {
    expect(faderToGain(0)).toBe(1)
    expect(faderToGain(100)).toBe(MAX_VOLUME)
    expect(faderToGain(-100)).toBe(0)
    expect(gainText(faderToGain(-50))).toBe('−30 dB')
    expect(gainText(faderToGain(50))).toBe('+6 dB')
    expect(gainText(faderToGain(-99.9))).toBe('−59.9 dB')
  })

  it('倍数换回推子位置；静音在最左，超出上限的夹到最右', () => {
    expect(gainToFader(1)).toBe(0)
    expect(gainToFader(0)).toBe(-100)
    expect(gainToFader(10)).toBe(100)
    expect(Math.round(gainToFader(faderToGain(-70)))).toBe(-70)
    expect(Math.round(gainToFader(faderToGain(37)))).toBe(37)
  })

  it('读数写 dB，整数不带小数点，0 写「静音」', () => {
    expect(gainText(1)).toBe('0 dB')
    expect(gainText(0)).toBe('静音')
    expect(gainText(10 ** (3.5 / 20))).toBe('+3.5 dB')
    expect(gainText(0.5)).toBe('−6 dB')
  })

  it('键盘按 dB 步进，落在 0.5 dB 的格上；最高 +12 dB，低于 −60 dB 即静音，静音往右回到 −60 dB', () => {
    expect(gainText(stepGain(1, 0.5))).toBe('+0.5 dB')
    expect(gainText(stepGain(1, -3))).toBe('−3 dB')
    expect(gainText(stepGain(10 ** (0.3 / 20), 0.5))).toBe('+1 dB')
    expect(stepGain(MAX_VOLUME, 3)).toBe(MAX_VOLUME)
    expect(stepGain(10 ** (-59.5 / 20), -3)).toBe(0)
    expect(gainText(stepGain(0, 0.5))).toBe('−60 dB')
    expect(stepGain(0, -0.5)).toBe(0)
  })
})
