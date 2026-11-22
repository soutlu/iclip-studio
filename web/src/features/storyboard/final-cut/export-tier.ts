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

/** 画面 `canvas` 按 `tier` 导出是什么样（规则见 `tierOutput`）。 */
export const exportOutput = (canvas: Canvas, tier: ExportTier) => tierOutput(LIBRARY, canvas, tier)

const storageKey = (conversationId: string) => `cue.final-cut.export-tier:${conversationId}`

const zTier = z.enum(EXPORT_TIERS)

/**
 * 用户在画面设置里选的导出分辨率档位，按对话记在浏览器里（不写进工程、不进撤销）；没选过时是 undefined。
 * 画面尺寸变了选的档不能选时也不清掉，换回能选的画面又亮（见 `exportTierOf`）。
 */
export function useChosenTier(conversationId: string) {
  const key = storageKey(conversationId)
  const [chosen, setChosen] = useState(() => readStoredJson(key, zTier))
  const choose = (next: ExportTier) => {
    setChosen(next)
    // 浏览器禁用或写满 Web Storage 时只是刷新后记不住，这次照常用
    writeStored(key, next)
  }
  return [chosen, choose] as const
}

/**
 * 画面 `canvas` 下亮着的导出档位（`tier`）：选的档 `chosen` 还能选时是它，否则是画面档，都没有时是 undefined。
 * `resolution` 是发起导出时带的档位：亮着的档和画面档不同时是它，否则是 null。
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
