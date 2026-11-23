import type { Canvas } from './composition/film'

/** 画面尺寸预设列表，短边统一为 1080 像素。 */
export const CANVAS_SIZES = [
  { label: '9:16', canvas: { width: 1080, height: 1920 } },
  { label: '3:4', canvas: { width: 1080, height: 1440 } },
  { label: '1:1', canvas: { width: 1080, height: 1080 } },
  { label: '4:3', canvas: { width: 1440, height: 1080 } },
  { label: '16:9', canvas: { width: 1920, height: 1080 } },
  { label: '21:9', canvas: { width: 2520, height: 1080 } },
] as const

/** 查找与 `canvas` 宽高完全匹配的预设；无匹配时返回 `undefined`。 */
export const presetOf = (canvas: Canvas) =>
  CANVAS_SIZES.find(
    (each) => each.canvas.width === canvas.width && each.canvas.height === canvas.height,
  )

// 宽高约分后两项均不超过此上限时以比例形式展示，否则直接展示 `宽×高`
const SIMPLE_RATIO_MAX = 32

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * 生成画面尺寸简称：命中预设时返回预设名（如 `9:16`）；否则若约分后两项均不超过 32 返回最简整数比（如 1280×800 → `8:5`）；其余情况返回 `宽×高`。
 */
export function canvasLabel(canvas: Canvas): string {
  const preset = presetOf(canvas)
  if (preset !== undefined) return preset.label
  const divisor = gcd(canvas.width, canvas.height)
  const [w, h] = [canvas.width / divisor, canvas.height / divisor]
  return w <= SIMPLE_RATIO_MAX && h <= SIMPLE_RATIO_MAX
    ? `${w}:${h}`
    : `${canvas.width}×${canvas.height}`
}

const SHORT_SIDE = 1080
// 素材宽高常经编码器取偶舍入，单边与预设比例偏差在该像素容差内即视为同一比例
const ROUNDING_PX = 2

const even = (value: number) => Math.round(value / 2) * 2

/**
 * 计算首次向空白工程加入视频时的目标画布尺寸：按 `video` 比例将短边归一化为 1080 并取偶数；
 * 若与某预设仅存在编码取整误差则直接采用预设尺寸（如 480×854 → 1080×1920，1280×720 → 1920×1080）。
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
