/** 两栏的布局：normal 是配置编辑器配预览或普通配置面板，wide 是右栏放技能编辑器这类长文本面板。 */
export type SplitMode = 'normal' | 'wide'

/** 每种布局各自记住的左栏占比（0–1 之间，按容器宽度换算）。 */
export type SplitLayout = Record<SplitMode, number>

export const DEFAULT_SPLIT: SplitLayout = { normal: 1 / 2, wide: 2 / 5 }

const MIN_WIDTH: Record<SplitMode, { left: number; right: number }> = {
  normal: { left: 360, right: 400 },
  wide: { left: 420, right: 400 },
}

/** 左栏可拖动的像素范围；容器放不下两栏最小宽时左栏保底，右栏让出宽度。 */
export function splitBounds(mode: SplitMode, width: number) {
  const { left, right } = MIN_WIDTH[mode]
  return { min: left, max: Math.max(left, width - right) }
}

/** 按容器宽度把记住的占比换算成左栏像素宽，并夹在最小宽之内；窗口变化时只影响换算结果、不改记住的占比。 */
export function resolveSplitLeft(share: number, width: number, mode: SplitMode): number {
  const { min, max } = splitBounds(mode, width)
  return Math.min(Math.max(share * width, min), max)
}

/** 把当前布局的左栏拖到 rawLeft 像素后得到的新占比，另一种布局保持不变；容器放不下两栏最小宽时不改。 */
export function resizeSplit(
  layout: SplitLayout,
  mode: SplitMode,
  rawLeft: number,
  width: number,
): SplitLayout {
  const { min, max } = splitBounds(mode, width)
  if (max <= min) return layout
  return { ...layout, [mode]: resolveSplitLeft(rawLeft / width, width, mode) / width }
}
