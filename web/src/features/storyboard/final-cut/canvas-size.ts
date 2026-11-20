import type { Canvas } from './composition/film'

/** 「画面尺寸」能选的比例，短边都是 1080。 */
export const CANVAS_SIZES = [
  { label: '9:16', canvas: { width: 1080, height: 1920 } },
  { label: '3:4', canvas: { width: 1080, height: 1440 } },
  { label: '1:1', canvas: { width: 1080, height: 1080 } },
  { label: '4:3', canvas: { width: 1440, height: 1080 } },
  { label: '16:9', canvas: { width: 1920, height: 1080 } },
  { label: '21:9', canvas: { width: 2520, height: 1080 } },
] as const

const SHORT_SIDE = 1080
// 素材的宽高是取过整的（常取成偶数）：每边和按预设比例算的差在这么多像素以内，算同一个比例
const ROUNDING_PX = 2

const even = (value: number) => Math.round(value / 2) * 2

/**
 * final-cut 放进第一段视频时画面改成的尺寸，`video` 是这段视频的宽高：比例跟视频，短边 1080，宽高取偶数；和
 * 预设的比例只差取整误差时用预设的尺寸（480×854 → 1080×1920，1280×720 → 1920×1080）。
 */
export function canvasForVideo(video: Canvas): Canvas {
  const scale = SHORT_SIDE / Math.min(video.width, video.height)
  const tolerance = ROUNDING_PX * scale
  const preset = CANVAS_SIZES.find(
    ({ canvas }) =>
      Math.abs(video.width * scale - canvas.width) <= tolerance &&
      Math.abs(video.height * scale - canvas.height) <= tolerance,
  )
  return preset?.canvas ?? { width: even(video.width * scale), height: even(video.height * scale) }
}
