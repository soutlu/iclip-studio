const KB = 1024
const MB = 1024 * 1024

export const formatAttachmentSize = (bytes: number): string => {
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

export const formatDimensions = (width: number, height: number): string => `${width} × ${height}`

export const formatDuration = (seconds: number): string => {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

const NAME_MAX_GRAPHEMES = 32
const TAIL_EXTRA = 4

let segmenter: Intl.Segmenter | undefined
const graphemes = (text: string): string[] => {
  segmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' })
  return [...segmenter.segment(text)].map((part) => part.segment)
}

const headEllipsize = (name: string, limit: number): string => {
  const chars = graphemes(name)
  return chars.length <= limit ? name : `${chars.slice(0, limit - 1).join('')}…`
}

export const ellipsizeAttachmentName = (name: string): string => {
  const chars = graphemes(name)
  if (chars.length <= NAME_MAX_GRAPHEMES) return name
  const dot = name.lastIndexOf('.')
  const tailLength = (dot > 0 ? graphemes(name.slice(dot)).length : 0) + TAIL_EXTRA
  const headLength = NAME_MAX_GRAPHEMES - 1 - tailLength
  if (headLength < 2) return headEllipsize(name, NAME_MAX_GRAPHEMES)
  return `${chars.slice(0, headLength).join('')}…${chars.slice(chars.length - tailLength).join('')}`
}
