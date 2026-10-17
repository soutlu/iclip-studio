/** 自定义字体在原视频画布上排版，预览只等比缩放；与服务端 ASS 的字号、边距和贪心换行一致。 */
import { normalizeCaptionText } from '@/shared/lib/use-preview-font'

export type CaptionFrame = { width: number; height: number }
export type CaptionFont = {
  fontFamily: string
  fontWeight: number
  fontStyle: 'normal' | 'italic' | 'oblique'
}
export type CaptionMetrics = {
  fontSize: number
  outline: number
  marginSide: number
  marginBottom: number
  lineWidth: number
}
export type CaptionPresentation = CaptionFont &
  CaptionMetrics & {
    frame: CaptionFrame
    lineHeight: number
  }

export const captionMetrics = ({ width, height }: CaptionFrame): CaptionMetrics => {
  const fontSize = Math.max(1, Math.round(height * 0.045))
  const outline = Math.max(1, Math.round(fontSize * 0.08))
  const marginSide = Math.round(width * 0.06)
  return {
    fontSize,
    outline,
    marginSide,
    marginBottom: Math.round(height * 0.12),
    lineWidth: Math.max(fontSize, width - 2 * marginSide - 2 * outline),
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** 每次量整个候选行以保留字偶距；显式换行保留，自动断行处去掉边缘空白。 */
export const wrapCaption = (
  text: string,
  lineWidth: number,
  measure: (text: string) => number,
): string => {
  const lines: string[] = []
  for (const paragraph of normalizeCaptionText(text).split('\n')) {
    let line = ''
    for (const { segment } of graphemes.segment(paragraph)) {
      const candidate = line + segment
      if (measure(candidate) > lineWidth) {
        if (line === '' || measure(segment) > lineWidth)
          throw new Error('字幕字形超过可用画面宽度，请调整字幕或字体')
        lines.push(line.trimEnd())
        line = segment.trimStart()
      } else line = candidate
    }
    if (line !== '') lines.push(line.trimEnd())
  }
  return lines.filter((line) => line !== '').join('\n')
}

type CaptionLayout =
  | { kind: 'ready'; texts: ReadonlyMap<string, string>; presentation: CaptionPresentation }
  | { kind: 'failed'; message: string }

/** FontFace 加载并完成缺字检查后调用；不能量字时明确阻止合成，不画替代字体。 */
export const measureCaptionLayout = (
  texts: readonly string[],
  frame: CaptionFrame,
  font: CaptionFont,
): CaptionLayout => {
  const context = document.createElement('canvas').getContext('2d')
  if (context === null)
    return { kind: 'failed', message: '当前浏览器无法测量字幕字体，请更换浏览器' }
  const metrics = captionMetrics(frame)
  context.font = `${font.fontStyle} ${font.fontWeight} ${metrics.fontSize}px "${font.fontFamily}"`
  context.fontKerning = 'normal'
  const measure = (text: string) => context.measureText(text).width
  const sample = texts.find((text) => normalizeCaptionText(text) !== '')
  const measured = context.measureText(sample ?? '')
  const lineHeight =
    sample === undefined
      ? metrics.fontSize
      : measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent
  if (!Number.isFinite(lineHeight) || lineHeight <= 0)
    return { kind: 'failed', message: '字体行高无法读取，请选择其他字体' }
  try {
    return {
      kind: 'ready',
      texts: new Map(texts.map((text) => [text, wrapCaption(text, metrics.lineWidth, measure)])),
      presentation: { ...font, ...metrics, frame, lineHeight },
    }
  } catch (error) {
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message : '字幕排版失败，请选择其他字体',
    }
  }
}
