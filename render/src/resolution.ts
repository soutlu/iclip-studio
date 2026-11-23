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

/** 从合成根元素的 `data-width` / `data-height` 读取画布尺寸；未声明或非正整数时返回 undefined。 */
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
 * 计算按档位 `tier` 导出主文件 `main` 时传给渲染器的 `outputResolution`：未指定档位或档位与画布原始
 * 档位一致时返回 undefined（按画布原始尺寸导出），否则返回同宽高比预设（规则见 `tierOutput`）。
 * 若当前画布不支持该档位，则抛出 `resolution-unsupported` 失败。
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
