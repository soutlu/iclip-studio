import { getAudioFxDef, type HfAudioFxNumberParam } from '@hyperframes/core/audio-fx'
import { describe, expect, it } from 'vitest'
import {
  paramAt,
  paramPosition,
  paramPositions,
  paramText,
  parseParamText,
  snapParam,
} from './fx-params'
import { ADDABLE_EFFECTS } from './mix-fx'

const param = (effect: string, key: string) => {
  const found = getAudioFxDef(effect)?.params.find((candidate) => candidate.key === key)
  if (found?.kind !== 'number') throw new Error(`${effect}.${key} 不是数字参数`)
  return found satisfies HfAudioFxNumberParam
}

describe('效果参数的滑杆', () => {
  it('线性的一格是一个步长，两头是 core 的范围', () => {
    const threshold = param('compressor', 'threshold')
    expect(paramPositions(threshold)).toBe(120)
    expect(paramAt(threshold, 0)).toBe(-60)
    expect(paramAt(threshold, 120)).toBe(0)
    expect(paramAt(threshold, 72)).toBe(-24)
    expect(paramPosition(threshold, -24)).toBe(72)
  })

  it('对数刻度的（频率、时间）按对数铺开，正中是几何中点，取值至少留三位有效数字', () => {
    const cutoff = param('lowpass', 'frequency')
    const last = paramPositions(cutoff)
    expect(paramAt(cutoff, 0)).toBe(100)
    expect(paramAt(cutoff, last)).toBe(20_000)
    expect(paramAt(cutoff, last / 2)).toBe(1414)
    expect(paramPosition(cutoff, 1414)).toBe(last / 2)
    // 下限比步长还小的一头不挤成同一个值
    const release = param('compressor', 'release')
    expect(paramAt(release, 0)).toBe(0.01)
    expect(paramAt(release, 1)).toBeGreaterThan(0.01)
    expect(paramText(release, paramAt(release, 1))).toBe('0.0107ms')
  })

  it('能加的七种效果的每个数字参数：每一格都是不同的取值，取值放回去还在那一格', () => {
    for (const type of ADDABLE_EFFECTS)
      for (const candidate of getAudioFxDef(type)?.params ?? []) {
        if (candidate.kind !== 'number') continue
        for (let position = 0; position <= paramPositions(candidate); position += 1)
          expect(
            paramPosition(candidate, paramAt(candidate, position)),
            `${type}.${candidate.key}@${position}`,
          ).toBe(position)
      }
  })

  it('显示带 core 的单位，小数位按步长；输入的数后面可以带单位，读进来按范围、步长收', () => {
    expect(paramText(param('compressor', 'ratio'), 4)).toBe('4.0:1')
    expect(paramText(param('truepeak', 'ceiling'), -1)).toBe('-1.0dBTP')
    expect(paramText(param('reverb', 'wet'), 0.35)).toBe('0.35')
    expect(paramText(param('delay', 'time'), 250)).toBe('250ms')
    expect(parseParamText('1800 Hz')).toBe(1800)
    expect(parseParamText('-3.5dB')).toBe(-3.5)
    expect(parseParamText('响一点')).toBeNull()
    expect(snapParam(param('compressor', 'threshold'), -24.3)).toBe(-24.5)
    expect(snapParam(param('compressor', 'threshold'), 12)).toBe(0)
  })
})
