import {
  CANVAS_DIMENSIONS,
  checkOutputResolutionCompatibility,
  normalizeResolutionFlag,
  suggestMatchingPreset,
  type CanvasResolution,
} from '@hyperframes/core'
import { parse } from 'parse5'
import {
  tierOutput,
  tierUnsupportedText,
  type ExportTier,
  type ResolutionLibrary,
} from '../../web/src/features/storyboard/final-cut/composition/export-resolution'
import { ExportFailure } from './jobs'
import { compositionRootOf } from './project'

const LIBRARY: ResolutionLibrary<CanvasResolution> = {
  CANVAS_DIMENSIONS,
  checkOutputResolutionCompatibility,
  normalizeResolutionFlag,
  suggestMatchingPreset,
}

/** 根上 `data-width` / `data-height` 写的画面尺寸；没写或不是正整数时是 undefined。 */
function canvasOf(html: string) {
  const root = compositionRootOf(parse(html))
  const side = (name: string) => {
    const value = Number(root?.attrs.find((attr) => attr.name === name)?.value)
    return Number.isInteger(value) && value > 0 ? value : undefined
  }
  const [width, height] = [side('data-width'), side('data-height')]
  return width === undefined || height === undefined ? undefined : { width, height }
}

/**
 * 按档位 `tier` 导出主文件 `main` 时交给渲染器的 `outputResolution`：没选档位、档位就是画面档时是 undefined
 * （按画面尺寸出片），否则是同形状的预设（规则见 `tierOutput`）。这个画面导不出这一档时以
 * `resolution-unsupported` 失败。
 */
export function outputResolutionFor(
  main: string,
  tier: ExportTier | null,
): CanvasResolution | undefined {
  if (tier === null) return undefined
  const canvas = canvasOf(main)
  const output = canvas === undefined ? undefined : tierOutput(LIBRARY, canvas, tier)
  if (output === undefined || output.kind === 'unsupported')
    throw new ExportFailure('resolution-unsupported', tierUnsupportedText(tier))
  return output.kind === 'preset' ? output.preset : undefined
}
