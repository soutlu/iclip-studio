import type { Canvas } from './film'

/** 导出分辨率能选的档位，从低到高。档位是每次导出的请求参数，不写进工程。 */
export const EXPORT_TIERS = ['480p', '720p', '1080p'] as const

export type ExportTier = (typeof EXPORT_TIERS)[number]

/** 界面和报错里写的档位：`720P`。 */
export const tierLabel = (tier: ExportTier) => tier.toUpperCase()

/** 这个画面导不出 `tier` 时给人看的一句话。 */
export const tierUnsupportedText = (tier: ExportTier) =>
  `当前画面尺寸不支持按 ${tierLabel(tier)} 导出`

/** 画面档：短边正好是 480 / 720 / 1080 时，按画面尺寸导出就是这一档；别的尺寸没有画面档。 */
export const canvasTier = ({ width, height }: Canvas): ExportTier | undefined =>
  EXPORT_TIERS.find((tier) => Number.parseInt(tier, 10) === Math.min(width, height))

/**
 * 导出库里判断预设的几个函数，由调用方传进来（编辑器和渲染服务各从自己装的导出库包里取）：这个目录不 import 包，
 * 渲染服务的检查只装它自己的依赖。
 */
export interface ResolutionLibrary<Preset extends string> {
  CANVAS_DIMENSIONS: Readonly<Record<Preset, Canvas>>
  normalizeResolutionFlag(input: string): Preset | undefined
  suggestMatchingPreset(width: number, height: number, chosen: Preset): Preset | undefined
  checkOutputResolutionCompatibility(input: {
    compositionWidth: number
    compositionHeight: number
    outputResolution: Preset
  }): { ok: boolean }
}

/**
 * 按某一档导出是什么样：`canvas` 就按画面尺寸导出，不用换；`preset` 交给渲染器的预设名和它出片的尺寸；
 * `unsupported` 这个画面导不出这一档。
 */
export type TierOutput<Preset extends string> =
  { kind: 'canvas' } | { kind: 'preset'; preset: Preset; size: Canvas } | { kind: 'unsupported' }

/**
 * 画面 `canvas` 按 `tier` 导出是什么样。等于画面档时不用换；否则照导出库的做法找同形状、同一档的预设，并且导出库
 * 判断能导（缩小随意，放大只能整数倍）。只有 16:9、9:16、1:1 三种形状有预设。
 */
export function tierOutput<Preset extends string>(
  library: ResolutionLibrary<Preset>,
  canvas: Canvas,
  tier: ExportTier,
): TierOutput<Preset> {
  if (canvasTier(canvas) === tier) return { kind: 'canvas' }
  const flag = library.normalizeResolutionFlag(tier)
  const preset =
    flag === undefined
      ? undefined
      : library.suggestMatchingPreset(canvas.width, canvas.height, flag)
  if (
    preset === undefined ||
    !library.checkOutputResolutionCompatibility({
      compositionWidth: canvas.width,
      compositionHeight: canvas.height,
      outputResolution: preset,
    }).ok
  )
    return { kind: 'unsupported' }
  return { kind: 'preset', preset, size: library.CANVAS_DIMENSIONS[preset] }
}
