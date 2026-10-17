import { escapeAssControls, normalizeCaptionText } from '@/shared/lib/caption-text'
import { isWideCodePoint } from './east-asian-width'

export const CAPTION_STYLE = {
  fontSizeOfHeight: 0.045,
  outlineOfFontSize: 0.08,
  bottomMarginOfHeight: 0.12,
  sideMarginOfWidth: 0.06,
} as const

export const DEFAULT_FONT_GLYPH_EM = { wide: 0.7, narrow: 0.45 } as const

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
export type CaptionPresentation = {
  frame: CaptionFrame
  font: CaptionFont | null
  fontSize: number
  lineHeight: number
  outline: number
  marginSide: number
  marginBottom: number
}
export type CaptionLayout =
  | { kind: 'ready'; texts: ReadonlyMap<string, string>; presentation: CaptionPresentation }
  | { kind: 'failed'; message: string }

// 后端默认字体用 Python 的 round 取整，.5 取偶；自定义字体用 floor(x + 0.5)。
export const roundHalfEven = (value: number): number => {
  const floor = Math.floor(value)
  if (value - floor !== 0.5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}

const roundHalfUp = (value: number): number => Math.floor(value + 0.5)

export const captionMetrics = (
  { width, height }: CaptionFrame,
  font: 'default' | 'custom',
): CaptionMetrics => {
  const toPixels = font === 'default' ? roundHalfEven : roundHalfUp
  const fontSize = Math.max(1, toPixels(height * CAPTION_STYLE.fontSizeOfHeight))
  const outline = Math.max(1, toPixels(fontSize * CAPTION_STYLE.outlineOfFontSize))
  const marginSide = toPixels(width * CAPTION_STYLE.sideMarginOfWidth)
  const available = width - 2 * marginSide
  return {
    fontSize,
    outline,
    marginSide,
    marginBottom: toPixels(height * CAPTION_STYLE.bottomMarginOfHeight),
    lineWidth: Math.max(fontSize, font === 'default' ? available : available - 2 * outline),
  }
}

// 后端按 Python 的 str.splitlines() 分段、str.strip() 去空白，两者认的字符集与 JS 的 split / trim 不同。
const PYTHON_LINE_BREAKS: ReadonlySet<number> = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
])
const PYTHON_SPACES: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
])

const pythonStrip = (text: string): string => {
  let start = 0
  let end = text.length
  while (start < end && PYTHON_SPACES.has(text.charCodeAt(start))) start += 1
  while (end > start && PYTHON_SPACES.has(text.charCodeAt(end - 1))) end -= 1
  return text.slice(start, end)
}

const pythonSplitLines = (text: string): string[] => {
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (!PYTHON_LINE_BREAKS.has(code)) continue
    lines.push(text.slice(start, index))
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1
    start = index + 1
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

// Python 3.12 起 sum() 对浮点数做 Neumaier 补偿求和，按同样方式累加才能在边界上与后端同判。
const pythonSum = (values: readonly number[]): number => {
  let sum = 0
  let compensation = 0
  for (const value of values) {
    const next = sum + value
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum
    sum = next
  }
  return compensation !== 0 && Number.isFinite(compensation) ? sum + compensation : sum
}

const estimatedWrap = (paragraph: string, fontSize: number, lineWidth: number): string[] => {
  const chars = [...paragraph]
  const widths = chars.map(
    (char) =>
      fontSize *
      (isWideCodePoint(char.codePointAt(0) ?? 0)
        ? DEFAULT_FONT_GLYPH_EM.wide
        : DEFAULT_FONT_GLYPH_EM.narrow),
  )
  const total = pythonSum(widths)
  if (total <= lineWidth) return [paragraph]
  const count = Math.ceil(total / Math.max(1, lineWidth - Math.max(...widths)))
  const share = total / count
  const lines = Array.from({ length: count }, () => '')
  let used = 0
  chars.forEach((char, index) => {
    const width = widths[index] ?? 0
    const line = Math.min(count - 1, Math.trunc((used + width / 2) / share))
    lines[line] += char
    used += width
  })
  return lines.map(pythonStrip)
}

export const defaultCaptionLines = (text: string, fontSize: number, lineWidth: number): string[] =>
  pythonSplitLines(escapeAssControls(text)).flatMap((paragraph) =>
    estimatedWrap(pythonStrip(paragraph), fontSize, lineWidth),
  )

export const defaultCaptionLayout = (
  texts: readonly string[],
  frame: CaptionFrame,
): CaptionLayout => {
  const metrics = captionMetrics(frame, 'default')
  return {
    kind: 'ready',
    texts: new Map(
      texts.map((text) => [
        text,
        defaultCaptionLines(text, metrics.fontSize, metrics.lineWidth)
          .filter((line) => line !== '')
          .join('\n'),
      ]),
    ),
    presentation: {
      frame,
      font: null,
      fontSize: metrics.fontSize * DEFAULT_FONT_GLYPH_EM.wide,
      lineHeight: metrics.fontSize,
      outline: metrics.outline,
      marginSide: metrics.marginSide,
      marginBottom: metrics.marginBottom,
    },
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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

export const measureCaptionLayout = (
  texts: readonly string[],
  frame: CaptionFrame,
  font: CaptionFont,
): CaptionLayout => {
  const context = document.createElement('canvas').getContext('2d')
  if (context === null)
    return { kind: 'failed', message: '当前浏览器无法测量字幕字体，请更换浏览器' }
  const metrics = captionMetrics(frame, 'custom')
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
    return { kind: 'failed', message: '字体行高读取失败，请选择其他字体' }
  try {
    return {
      kind: 'ready',
      texts: new Map(texts.map((text) => [text, wrapCaption(text, metrics.lineWidth, measure)])),
      presentation: {
        frame,
        font,
        fontSize: metrics.fontSize,
        lineHeight,
        outline: metrics.outline,
        marginSide: metrics.marginSide,
        marginBottom: metrics.marginBottom,
      },
    }
  } catch (error) {
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message : '字幕排版失败，请选择其他字体',
    }
  }
}
