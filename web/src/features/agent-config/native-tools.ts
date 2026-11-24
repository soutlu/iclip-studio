import type { NativeToolOut } from '@/shared/api/generated/types.gen'

export type NativeTool = NativeToolOut
export type NativeToolName = NativeTool['name']

/**
 * 从 `selected` 里留下 `available` 中有、且依赖都还开着的原生工具，按名录顺序返回。
 * 被依赖的工具被去掉时，依赖它的也一并去掉。
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

/** 开或关一个原生工具：依赖没全开时开不了；关掉时依赖它的一并关掉。 */
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
