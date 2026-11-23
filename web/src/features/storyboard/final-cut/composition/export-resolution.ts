import type { Canvas } from './film'

/** 可选导出分辨率档位（由低到高）。档位仅作为单次导出请求参数，不写入工程文件。 */
export const EXPORT_TIERS = ['480p', '720p', '1080p'] as const

export type ExportTier = (typeof EXPORT_TIERS)[number]

/** 界面与报错文案使用的档位展示名（如 `720P`）。 */
export const tierLabel = (tier: ExportTier) => tier.toUpperCase()

/** 当前画幅不支持以 `tier` 档位导出时的提示文案。 */
export const tierUnsupportedText = (tier: ExportTier) =>
  `当前画面尺寸不支持按 ${tierLabel(tier)} 导出`

/** 画布原生档位：短边恰好为 480 / 720 / 1080 时对应导出档位，其余尺寸返回 `undefined`。 */
export const canvasTier = ({ width, height }: Canvas): ExportTier | undefined =>
  EXPORT_TIERS.find((tier) => Number.parseInt(tier, 10) === Math.min(width, height))

/**
 * 导出库分辨率预设校验接口，由调用方注入（编辑器与渲染服务各自从自身依赖包传入）：
 * 本目录不直接 import 外部包，以保证渲染服务仅安装自身依赖即可通过检查。
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
 * 指定档位的导出决议：`canvas` 表示直接按画布原尺寸导出；`preset` 返回传给渲染器的预设名与实际成片尺寸；
 * `unsupported` 表示当前画布尺寸不支持该档位。
 */
export type TierOutput<Preset extends string> =
  { kind: 'canvas' } | { kind: 'preset'; preset: Preset; size: Canvas } | { kind: 'unsupported' }

/**
 * 计算画布 `canvas` 按档位 `tier` 导出的决议：匹配画布原生档位时直接按原尺寸导出；
 * 否则委托导出库查找同画幅比例的对应预设并校验兼容性（允许任意缩小，放大仅限整数倍；目前仅 16:9、9:16、1:1 提供预设）。
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
