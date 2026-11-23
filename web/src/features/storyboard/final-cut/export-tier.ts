import {
  CANVAS_DIMENSIONS,
  checkOutputResolutionCompatibility,
  normalizeResolutionFlag,
  suggestMatchingPreset,
  type CanvasResolution,
} from '@hyperframes/parsers'
import { useState } from 'react'
import { z } from 'zod'
import { readStoredJson, writeStored } from '../editing/browser-storage'
import {
  canvasTier,
  EXPORT_TIERS,
  tierOutput,
  type ExportTier,
  type ResolutionLibrary,
} from './composition/export-resolution'
import type { Canvas } from './composition/film'

const LIBRARY: ResolutionLibrary<CanvasResolution> = {
  CANVAS_DIMENSIONS,
  checkOutputResolutionCompatibility,
  normalizeResolutionFlag,
  suggestMatchingPreset,
}

/** 计算画布 `canvas` 按档位 `tier` 导出的决议（规则见 `tierOutput`）。 */
export const exportOutput = (canvas: Canvas, tier: ExportTier) => tierOutput(LIBRARY, canvas, tier)

const storageKey = (conversationId: string) => `cue.final-cut.export-tier:${conversationId}`

const zTier = z.enum(EXPORT_TIERS)

/**
 * 按对话在浏览器本地持久化用户选择的导出分辨率档位（不写入工程文件，不计入撤销栈）；未选择过时为 `undefined`。
 * 画布尺寸变化导致所选档位暂不可用时仍保留记忆，切回兼容画幅后自动重新生效（见 `exportTierOf`）。
 */
export function useChosenTier(conversationId: string) {
  const key = storageKey(conversationId)
  const [chosen, setChosen] = useState(() => readStoredJson(key, zTier))
  const choose = (next: ExportTier) => {
    setChosen(next)
    // 浏览器禁用或写满 Web Storage 时仅本次会话生效，不影响正常操作
    writeStored(key, next)
  }
  return [chosen, choose] as const
}

/**
 * 计算当前画布 `canvas` 下的激活导出档位（`tier`）与请求参数（`resolution`）：
 * `tier` 优先取兼容当前画布的 `chosen`，否则回退至画布原生档位，均无则为 `undefined`；
 * `resolution` 仅在激活档位须映射至渲染预设（区别于画布原尺寸）时携带该档位，否则为 `null`。
 */
export function exportTierOf(canvas: Canvas, chosen: ExportTier | undefined) {
  const tier =
    chosen !== undefined && exportOutput(canvas, chosen).kind !== 'unsupported'
      ? chosen
      : canvasTier(canvas)
  return {
    tier,
    resolution: tier !== undefined && exportOutput(canvas, tier).kind === 'preset' ? tier : null,
  }
}
