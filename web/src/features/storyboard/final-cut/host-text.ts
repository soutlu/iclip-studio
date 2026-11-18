import type { ComponentCatalog } from './composition/catalog'
import { itemNamed, type HostClip } from './composition/film'
import { fieldText, textFields, type LocaleBindings } from './composition/locale-text'
import { translationOf, type ShownLocale } from './locales'

/**
 * 组件或块的片段在 `shown` 这种语言下的文字（时间线上接在名字后面）：按条目里文字字段的先后取第一个非空的。
 * 原文下和固定的字段取宿主上的字；其它语言下随语言的字段（`bindings`）取这种语言的字，没翻的取原文。
 * 换行和连着的空白合成一个空格。条目查不到、没有文字字段、都是空的时是 null。
 */
export function hostTextIn(
  shown: ShownLocale,
  clip: HostClip,
  catalog: ComponentCatalog,
  bindings: LocaleBindings,
): string | null {
  const item = itemNamed(catalog, clip.item)
  for (const field of item === undefined ? [] : textFields(item)) {
    const variable = bindings[field.id]
    const translated = variable === undefined ? null : translationOf(shown.values, variable)
    const text = (translated ?? fieldText(clip.values, field)).replace(/\s+/g, ' ').trim()
    if (text !== '') return text
  }
  return null
}
