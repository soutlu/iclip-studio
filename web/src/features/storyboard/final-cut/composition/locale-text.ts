import type { CatalogItem, CatalogVariable, ComponentCatalog, VariableValue } from './catalog'
import { itemNamed, type FilmClip, type HostClip } from './film'

/**
 * 贴片、场景里文字可填项的「固定 / 随语言」。
 *
 * 挂载的组件文件只读宿主自己的 `data-variable-values`，读不到主文件根上的变量。所以一个字段随语言时，主文件根上
 * 声明一个字符串变量（id 见 `localeVariableId`，默认值是这个字段的原文），宿主上的 `data-locale-bindings` 记着
 * 「字段 id → 根变量 id」；宿主的 `data-variable-values` 里照旧写原文。没记在里面的字段是固定的，所有语言都用
 * 宿主上写着的字。预览原文以外的一种语言前先用 `localizedHostValues` 把这种语言的值并进各宿主的取值，按语言
 * 导出也用它。
 */
export const LOCALE_BINDINGS = 'data-locale-bindings'

/** 一个宿主上随语言的字段：字段 id → 主文件根上的变量 id。 */
export type LocaleBindings = Readonly<Record<string, string>>

const NO_BINDINGS: LocaleBindings = {}

/** 读 `data-locale-bindings` 的值；没写或写法不对（不是值为字符串的 JSON 对象）时都当作没有随语言的字段。 */
export function localeBindingsOf(json: string | undefined): LocaleBindings {
  if (json === undefined) return NO_BINDINGS
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return NO_BINDINGS
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_BINDINGS
  const entries = Object.entries(parsed as Record<string, unknown>)
  return entries.every(([, variable]) => typeof variable === 'string')
    ? (Object.fromEntries(entries) as Record<string, string>)
    : NO_BINDINGS
}

/** `data-locale-bindings` 要写的值；一个随语言的字段都没有时是 null（去掉这个属性）。 */
export const localeBindingsAttribute = (bindings: LocaleBindings): string | null =>
  Object.keys(bindings).length === 0 ? null : JSON.stringify(bindings)

/** 条目里能分语言的字段：类型是文字的可填项。 */
export const textFields = (item: CatalogItem): CatalogVariable[] =>
  item.variables.filter((variable) => variable.type === 'string')

/** 有文字字段的组件或块的片段，按开始时间排。 */
export const textHosts = (clips: readonly FilmClip[], catalog: ComponentCatalog): HostClip[] =>
  clips
    .filter((clip): clip is HostClip => {
      const item = clip.kind === 'host' ? itemNamed(catalog, clip.item) : undefined
      return item !== undefined && textFields(item).length > 0
    })
    .toSorted((left, right) => left.start - right.start)

/** 字段现在的字：宿主上填了用填的，没填用条目的默认值。 */
export const fieldText = (
  values: Readonly<Record<string, VariableValue>>,
  field: Pick<CatalogVariable, 'id' | 'default'>,
): string => String(values[field.id] ?? field.default)

/** 片段 `clipId` 的字段 `fieldId` 随语言时的根变量 id：带前缀，不和组件文件里的变量重名。 */
export const localeVariableId = (clipId: string, fieldId: string) => `txt_${clipId}_${fieldId}`

/** 随语言的字段在主文件根上的变量声明：默认值是这个字段的原文。 */
export const localeVariable = (id: string, label: string, text: string) => ({
  id,
  type: 'string' as const,
  label,
  default: text,
})

/** 要按语言并值的一个宿主：编号、现在的取值和随语言的字段。 */
export interface LocalizedHost {
  id: string
  values: Readonly<Record<string, VariableValue>>
  bindings: LocaleBindings
}

/**
 * 原文以外的一种语言下各宿主的取值：每个随语言的字段换成它的根变量在这种语言下的字——值表 `table` 里有（是字符串）就用，
 * 没有用根变量的默认值 `defaults`（变量 id → 默认值）；两处都没有时这个字段照旧。答复只含有随语言字段的宿主
 * （编号 → 新的取值），别的宿主（含字幕宿主）不在里面、不要动。
 */
export function localizedHostValues(
  hosts: readonly LocalizedHost[],
  table: Readonly<Record<string, unknown>>,
  defaults: ReadonlyMap<string, unknown>,
): Map<string, Record<string, VariableValue>> {
  const localized = new Map<string, Record<string, VariableValue>>()
  for (const host of hosts) {
    const bindings = Object.entries(host.bindings)
    if (bindings.length === 0) continue
    const values = { ...host.values }
    for (const [field, variable] of bindings) {
      const translated = Object.hasOwn(table, variable) ? table[variable] : undefined
      const text = typeof translated === 'string' ? translated : defaults.get(variable)
      if (typeof text === 'string') values[field] = text
    }
    localized.set(host.id, values)
  }
  return localized
}
