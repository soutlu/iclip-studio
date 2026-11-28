import type { CaptionTextChange } from './captions-tab'
import type { ComponentCatalog } from './composition/catalog'
import { itemNamed, type FilmClip } from './composition/film'
import { fieldText, type LocaleBindings } from './composition/locale-text'
import type { ItemTextChange } from './component-texts'
import { SOURCE_NAME, translationOf, type ShownLocale } from './locales'
import type { TextTarget } from './preview-player'

/** 原地改字编辑配置：字段名称、初始文本、不可改提示（外语模式下未开启「随语言」时）、是否多行及保存回调。 */
export type TextEdit = {
  label: string
  initial: string
  pinned: string | undefined
  multiline: boolean
  save: (text: string) => void
}

/** 原地改字要用的工程数据与保存通道（同画布叠层的同名属性）。 */
type TextEditSources = {
  catalog: ComponentCatalog
  locale: ShownLocale
  bindings: ReadonlyMap<string, LocaleBindings>
  onText: ItemTextChange
  onCaptionText: CaptionTextChange
}

/**
 * 构建原地改字编辑模型：元素/模板文字字段与「属性」面板共用同一保存通道，字幕与「字幕」页签共用同一保存通道；
 * 均作用于当前展示语言（未翻译项初始值回退为原文），目标片段或字段不存在时返回 `undefined`。
 */
export function textEditOf(
  target: TextTarget,
  clips: readonly FilmClip[],
  { catalog, locale, bindings, onText, onCaptionText }: TextEditSources,
): TextEdit | undefined {
  const clip = clips.find((each) => each.id === target.id)
  if (clip?.kind === 'caption') {
    const shown = translationOf(locale.values, clip.variable) ?? clip.text
    return {
      label: '字幕',
      initial: shown,
      pinned: undefined,
      multiline: true,
      save: (text) => onCaptionText(clip.id, text, locale.code),
    }
  }
  if (clip?.kind !== 'host') return undefined
  const field = itemNamed(catalog, clip.item)?.variables.find(
    (variable) => variable.id === target.field,
  )
  if (field === undefined) return undefined
  const source = fieldText(clip.values, field)
  const variable = bindings.get(clip.id)?.[target.field]
  return {
    label: field.label,
    initial:
      locale.values === null || variable === undefined
        ? source
        : (translationOf(locale.values, variable) ?? source),
    pinned:
      locale.values !== null && variable === undefined
        ? `「${field.label}」固定${SOURCE_NAME}，所有语言共用；请先在「属性」里点击「随语言」`
        : undefined,
    multiline: false,
    save: (text) => onText(clip.id, field.id, text, locale.code),
  }
}
