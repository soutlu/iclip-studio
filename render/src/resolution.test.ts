import { describe, expect, it } from 'vitest'
import { ExportFailure } from './jobs'
import { outputResolutionFor } from './resolution'
import { mainFile, video } from './testing'

const PORTRAIT = mainFile([video()], { width: 1080, height: 1920 })

describe('导出分辨率交给渲染器的预设', () => {
  it('没选档位、选的就是画面档时不换，按画面尺寸出片', () => {
    expect(outputResolutionFor(PORTRAIT, null)).toBeUndefined()
    expect(outputResolutionFor(PORTRAIT, '1080p')).toBeUndefined()
  })

  it('选了别的档、画面能导时是同形状的预设', () => {
    expect(outputResolutionFor(PORTRAIT, '720p')).toBe('portrait-720p')
    expect(outputResolutionFor(PORTRAIT, '480p')).toBe('portrait-480p')
    expect(outputResolutionFor(mainFile([video()], { width: 1920, height: 1080 }), '720p')).toBe(
      'landscape-720p',
    )
  })

  it('画面导不出这一档时以 resolution-unsupported 失败，说明是哪一档', () => {
    const threeByFour = mainFile([video()], { width: 1080, height: 1440 })
    const thrown = (() => {
      try {
        outputResolutionFor(threeByFour, '720p')
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(ExportFailure)
    expect(thrown).toMatchObject({
      code: 'resolution-unsupported',
      message: '当前画面尺寸不支持按 720P 导出',
    })
  })

  it('根上没写画面宽高时也算导不出', () => {
    const bare = '<html><body><div data-composition-id="film"></div></body></html>'
    expect(() => outputResolutionFor(bare, '480p')).toThrow('当前画面尺寸不支持按 480P 导出')
  })
})
