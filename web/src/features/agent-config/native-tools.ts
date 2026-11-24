import type { NativeToolOut } from '@/shared/api/generated/types.gen'

export type NativeTool = NativeToolOut
export type NativeToolName = NativeTool['name']

/**
 * 从 `selected` 中筛选出属于 `available` 且全部前置依赖仍满足的原生工具，按名录顺序返回。
 * 移除被依赖工具时，依赖它的工具一并移除。
 */
export const keepNativeTools = (
  catalog: readonly NativeTool[],
  selected: readonly NativeToolName[],
  available: readonly NativeToolName[],
): NativeToolName[] => {
  let kept = catalog.filter((tool) => selected.includes(tool.name) && available.includes(tool.name))
  for (;;) {
    const settled = kept.filter((tool) =>
      tool.requires.every((name) => kept.some((item) => item.name === name)),
    )
    if (settled.length === kept.length) return settled.map((tool) => tool.name)
    kept = settled
  }
}

/** 切换单个原生工具的开关状态：前置依赖未满足时无法开启；关闭时级联关闭依赖它的工具。 */
export const setNativeTool = (
  catalog: readonly NativeTool[],
  selected: readonly NativeToolName[],
  name: NativeToolName,
  on: boolean,
): NativeToolName[] =>
  keepNativeTools(
    catalog,
    on ? [...selected, name] : selected.filter((item) => item !== name),
    catalog.map((tool) => tool.name),
  )

export const nativeToolBlocked = (tool: NativeTool, selected: readonly NativeToolName[]): boolean =>
  tool.requires.some((name) => !selected.includes(name))
