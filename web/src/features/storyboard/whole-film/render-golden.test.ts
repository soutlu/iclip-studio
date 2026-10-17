import { describe, expect, it } from 'vitest'
import golden from '../../../../../contract/whole-film/render-golden.json'
import {
  CAPTION_STYLE,
  captionMetrics,
  DEFAULT_FONT_GLYPH_EM,
  defaultCaptionLayout,
  defaultCaptionLines,
  roundHalfEven,
} from './caption-layout'
import {
  FILM_LOUDNESS_LUFS,
  MAX_LOUDNESS_BOOST_DB,
  MUSIC_LOUDNESS_LUFS,
  PEAK_DBFS,
  SEGMENT_FADE_SECONDS,
  SPEECH_LOUDNESS_LUFS,
} from './film-audio'
import { MUSIC_FADE_OUT_SECONDS } from './film-music'

describe('与后端渲染金样对账', () => {
  it('预览混音的声音参数与后端渲染一致', () => {
    expect({
      speechLoudnessLufs: SPEECH_LOUDNESS_LUFS,
      musicLoudnessLufs: MUSIC_LOUDNESS_LUFS,
      loudnessLufs: FILM_LOUDNESS_LUFS,
      peakDbfs: PEAK_DBFS,
      segmentFadeMs: SEGMENT_FADE_SECONDS * 1000,
      musicFadeOutMs: MUSIC_FADE_OUT_SECONDS * 1000,
      maxLoudnessBoostDb: MAX_LOUDNESS_BOOST_DB,
    }).toEqual(golden.audio)
  })

  it('字幕样式比例与默认字体估宽一致', () => {
    expect(CAPTION_STYLE).toEqual(golden.captionStyle)
    expect({
      wideGlyphEm: DEFAULT_FONT_GLYPH_EM.wide,
      narrowGlyphEm: DEFAULT_FONT_GLYPH_EM.narrow,
    }).toEqual(golden.defaultFont)
  })

  it.each(golden.captions.map((item) => [`${item.width}×${item.height} ${item.text}`, item]))(
    '默认字体排版：%s',
    (_, item) => {
      const metrics = captionMetrics(item, 'default')
      expect(metrics).toEqual({
        fontSize: item.fontSize,
        outline: item.outline,
        marginSide: item.marginSide,
        marginBottom: item.marginBottom,
        lineWidth: item.lineWidth,
      })
      expect(defaultCaptionLines(item.text, metrics.fontSize, metrics.lineWidth)).toEqual(
        item.lines,
      )
    },
  )

  it('默认字体预览显示的折行与金样一致', () => {
    for (const item of golden.captions) {
      const layout = defaultCaptionLayout([item.text], item)
      expect(layout.kind).toBe('ready')
      if (layout.kind !== 'ready') continue
      expect(layout.texts.get(item.text)).toBe(item.lines.join('\n'))
      expect(layout.presentation).toMatchObject({
        font: null,
        marginSide: item.marginSide,
        marginBottom: item.marginBottom,
      })
    }
  })

  it.each([
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [57.5, 58],
    [58.5, 58],
    [58.49, 58],
    [58.51, 59],
  ])('像 Python round 一样取整：%s → %s', (value, expected) => {
    expect(roundHalfEven(value)).toBe(expected)
  })
})
