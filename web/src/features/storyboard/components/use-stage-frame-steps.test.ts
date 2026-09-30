import { describe, expect, it } from 'vitest'
import { frameStepOfKey } from './use-stage-frame-steps'

const press = (key: string, extra = {}) => ({
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  isComposing: false,
  key,
  metaKey: false,
  shiftKey: false,
  ...extra,
})

describe('frameStepOfKey', () => {
  it('→ 下一帧、← 上一帧，别的键不管', () => {
    expect(frameStepOfKey(press('ArrowRight'))).toBe(1)
    expect(frameStepOfKey(press('ArrowLeft'))).toBe(-1)
    expect(frameStepOfKey(press('ArrowDown'))).toBeUndefined()
    expect(frameStepOfKey(press('Enter'))).toBeUndefined()
  })

  it.each([
    ['带 Alt', { altKey: true }],
    ['带 Ctrl', { ctrlKey: true }],
    ['带 Meta', { metaKey: true }],
    ['带 Shift', { shiftKey: true }],
    ['输入法组词中', { isComposing: true }],
    ['已被别处处理', { defaultPrevented: true }],
  ])('%s的方向键不切帧', (_, extra) => {
    expect(frameStepOfKey(press('ArrowRight', extra))).toBeUndefined()
  })
})
