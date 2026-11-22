import {
  CANVAS_DIMENSIONS,
  checkOutputResolutionCompatibility,
  normalizeResolutionFlag,
  suggestMatchingPreset,
  type CanvasResolution,
} from '@hyperframes/parsers'
import { describe, expect, it } from 'vitest'
import { canvasTier, EXPORT_TIERS, tierOutput, type ResolutionLibrary } from './export-resolution'
import type { Canvas } from './film'

const library: ResolutionLibrary<CanvasResolution> = {
  CANVAS_DIMENSIONS,
  checkOutputResolutionCompatibility,
  normalizeResolutionFlag,
  suggestMatchingPreset,
}

/** 三个档位各是什么样：画面档写 canvas，有预设写「预设名 宽×高」，导不出写 unsupported。 */
const outputs = (canvas: Canvas) =>
  Object.fromEntries(
    EXPORT_TIERS.map((tier) => {
      const output = tierOutput(library, canvas, tier)
      return [
        tier,
        output.kind === 'preset'
          ? `${output.preset} ${output.size.width}×${output.size.height}`
          : output.kind,
      ]
    }),
  )

describe('导出分辨率档位', () => {
  it('竖屏 1080×1920：1080P 是画面档，480P、720P 缩成同形状的预设', () => {
    expect(canvasTier({ width: 1080, height: 1920 })).toBe('1080p')
    expect(outputs({ width: 1080, height: 1920 })).toEqual({
      '480p': 'portrait-480p 480×854',
      '720p': 'portrait-720p 720×1280',
      '1080p': 'canvas',
    })
  })

  it('3:4 的 1080×1440：1080P 是画面档，这个形状没有预设，480P、720P 导不出', () => {
    expect(outputs({ width: 1080, height: 1440 })).toEqual({
      '480p': 'unsupported',
      '720p': 'unsupported',
      '1080p': 'canvas',
    })
  })

  it('1280×800：短边不是三档之一，没有画面档，形状也没有预设，三档都导不出', () => {
    expect(canvasTier({ width: 1280, height: 800 })).toBeUndefined()
    expect(outputs({ width: 1280, height: 800 })).toEqual({
      '480p': 'unsupported',
      '720p': 'unsupported',
      '1080p': 'unsupported',
    })
  })

  it('480×854：480P 是画面档，放大到 720P、1080P 不是整数倍，导不出', () => {
    expect(outputs({ width: 480, height: 854 })).toEqual({
      '480p': 'canvas',
      '720p': 'unsupported',
      '1080p': 'unsupported',
    })
  })

  it('540×960 没有画面档；放大一倍正好是 1080P，能导，720P 不是整数倍导不出', () => {
    expect(outputs({ width: 540, height: 960 })).toEqual({
      '480p': 'portrait-480p 480×854',
      '720p': 'unsupported',
      '1080p': 'portrait 1080×1920',
    })
  })

  it('横屏 1920×1080 和方形 1080×1080 用各自形状的预设', () => {
    expect(outputs({ width: 1920, height: 1080 })).toEqual({
      '480p': 'landscape-480p 854×480',
      '720p': 'landscape-720p 1280×720',
      '1080p': 'canvas',
    })
    expect(outputs({ width: 1080, height: 1080 })).toEqual({
      '480p': 'square-480p 480×480',
      '720p': 'square-720p 720×720',
      '1080p': 'canvas',
    })
  })
})
