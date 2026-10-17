import { expect, it } from 'vitest'
import { keyframeRanges } from './keyframe-segments'

it('按关键帧切成 [k_i, k_i+1)，最后一段到片尾；第一个关键帧不在 0 上时片头也算一段', () => {
  expect(keyframeRanges({ keyframes: [0.5, 1.917, 1.917, 4.208], duration: 5.25 })).toEqual([
    { start: 0, end: 0.5 },
    { start: 0.5, end: 1.917 },
    { start: 1.917, end: 4.208 },
    { start: 4.208, end: 5.25 },
  ])
})
