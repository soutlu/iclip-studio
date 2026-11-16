import { MIN_CLIP_MS, type CaptionClip } from './composition/film'

/** 新加的一句字幕有多长（毫秒）。 */
export const CAPTION_MS = 2000

/** 新加的一句字幕先写的字。 */
export const NEW_CAPTION_TEXT = '新字幕'

export const CAPTION_REFUSAL_TEXT = {
  taken: '播放头处已有字幕，无法再加一句；请把播放头移到没有字幕的地方',
  tight: '播放头离下一句字幕不到 0.1 秒，无法加一句；请把播放头往前移',
} as const

/**
 * 在播放头 `playheadMs` 处加一句字幕时放在哪：从播放头起长 2 秒，碰到后面的字幕时缩短到碰到为止。
 * 播放头处已经有字幕、或者缩短后不到 0.1 秒时不能加，答复原因。
 */
export function captionSpot(
  captions: readonly Pick<CaptionClip, 'start' | 'duration'>[],
  playheadMs: number,
): { start: number; duration: number } | { refusal: keyof typeof CAPTION_REFUSAL_TEXT } {
  const start = Math.max(0, Math.round(playheadMs))
  if (
    captions.some((caption) => caption.start <= start && start < caption.start + caption.duration)
  )
    return { refusal: 'taken' }
  const next = Math.min(
    Infinity,
    ...captions.filter((caption) => caption.start > start).map((caption) => caption.start),
  )
  const duration = Math.min(CAPTION_MS, next - start)
  return duration < MIN_CLIP_MS ? { refusal: 'tight' } : { start, duration }
}

/** 字幕列表里写的时间：分:秒，秒带两位小数（`00:01.50`）。 */
export const captionClock = (ms: number): string => {
  const hundredths = Math.round(Math.max(0, ms) / 10)
  const minutes = Math.floor(hundredths / 6000)
  const seconds = ((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

/** 字幕按开始时间排，一样时按编号。 */
export const captionsInOrder = <T extends Pick<CaptionClip, 'id' | 'start'>>(
  captions: readonly T[],
): T[] =>
  captions.toSorted((left, right) => left.start - right.start || left.id.localeCompare(right.id))
