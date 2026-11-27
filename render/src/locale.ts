import {
  isCompositionVariable,
  validateVariables,
  type CompositionVariable,
  type CompositionVariableType,
} from '@hyperframes/core/variables'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { variableValuesOf } from '../../web/src/features/storyboard/final-cut/composition/film'
import {
  LOCALE_BINDINGS,
  localeBindingsOf,
  localizedHostValues,
} from '../../web/src/features/storyboard/final-cut/composition/locale-text'
import {
  CAPTION_OWNER,
  isCaptionsHost,
} from '../../web/src/features/storyboard/final-cut/composition/captions'
import {
  localizedVoices,
  ownedCaptions,
  VOICE_MODES,
  voiceModesOf,
} from '../../web/src/features/storyboard/final-cut/composition/voices'
import {
  applyEdits,
  attributeText,
  compositionRootOf,
  elementsOf,
  MAIN_FILE,
  type ProjectFile,
  type SourceEdit,
} from './project'
import type { ExportLocale } from './request'

/**
 * 按语言导出逻辑：final-cut 原文为视频自有语言（取主文件根元素变量的默认值，无独立值表），
 * 每种目标语言对应一份值表 `locales/<语言>.json`（变量 ID → 目标语言取值）。导出规则与编辑器多语言预览一致：
 * 字幕文本作为主文件根变量传给渲染器；元素与模板片段中的多语言字段由 `localizedHostValues`（与预览共用）
 * 合并至宿主元素的 `data-variable-values`；人声轨道由 `localizedVoices`（与预览共用）处理，导出原文时亦
 * 通过该函数移除其他语种的配音片段。
 */

/** 校验结果：成功时携带值，失败时携带面向用户的错误说明（不含值表具体文本）。 */
export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

const VALUES_ATTRIBUTE = 'data-variable-values'

/** 返回指定目标语言的值表在工程内的相对路径。 */
export const localePath = (locale: ExportLocale) => `locales/${locale}.json`

/** 从工程文件中读取 `locale` 对应的值表：要求文件存在且内容为 JSON 对象。 */
export function readLocaleTable(
  files: readonly ProjectFile[],
  locale: ExportLocale,
): Checked<Record<string, unknown>> {
  const file = files.find((candidate) => candidate.path === localePath(locale))
  if (file === undefined)
    return {
      ok: false,
      message: 'final-cut 工程中缺少该语言的语言文件，无法导出该语言版本',
    }
  let parsed: unknown
  try {
    parsed = JSON.parse(file.content)
  } catch {
    parsed = undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return {
      ok: false,
      message:
        '该语言的语言文件格式无效，无法导出该语言版本；请修正为变量 ID 对应文本的 JSON 对象后重新导出',
    }
  return { ok: true, value: { ...(parsed as Record<string, unknown>) } }
}

/**
 * 解析主文件根元素（`<html>`）的 `data-composition-variables` 变量声明。
 * 忽略格式无效的单条声明，属性整体无法解析时视为空声明，与引擎解析规则（`isCompositionVariable`）保持一致。
 */
export function rootDeclarations(html: string): CompositionVariable[] {
  const root = [...elementsOf(parse(html))].find((element) => element.tagName === 'html')
  const json = root?.attrs.find((attr) => attr.name === 'data-composition-variables')?.value
  if (json === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  return Array.isArray(parsed) ? parsed.filter(isCompositionVariable) : []
}

const TYPE_NAMES: Record<CompositionVariableType, string> = {
  string: '文字',
  number: '数字',
  color: '颜色',
  boolean: '开关',
  enum: '选项',
  font: '字体',
  image: '图片',
}

/**
 * 按主文件根元素的变量声明校验语言值表：自动过滤未声明的变量并统计剔除数量；
 * 若任意已声明变量的值类型不符或超出可选范围，则整份值表校验失败。
 */
export function checkLocaleValues(
  values: Readonly<Record<string, unknown>>,
  declarations: readonly CompositionVariable[],
): Checked<{ values: Record<string, unknown>; dropped: number }> {
  const issues = validateVariables({ ...values }, declarations)
  const wrong = issues.find((issue) => issue.kind !== 'undeclared')
  if (wrong !== undefined) {
    const declared = declarations.find((declaration) => declaration.id === wrong.variableId)
    const expected = declared === undefined ? '' : `，应为${TYPE_NAMES[declared.type]}`
    return {
      ok: false,
      message: `该语言的语言文件中变量 ${wrong.variableId} 的值无效${expected}，无法导出该语言版本；请在编辑器中修正该语言的文本后重新导出`,
    }
  }
  const undeclared = new Set(issues.map((issue) => issue.variableId))
  return {
    ok: true,
    value: {
      values: Object.fromEntries(Object.entries(values).filter(([id]) => !undeclared.has(id))),
      dropped: undeclared.size,
    },
  }
}

/**
 * 将主文件中元素与模板宿主的多语言属性替换为指定语言取值：仅重写含 `data-locale-bindings` 的宿主
 * `data-variable-values`（规则见 `localizedHostValues`，`values` 为已校验值表，`defaults` 为根变量默认值）。
 * 字幕宿主、无多语言绑定的宿主及主文件其余内容均保持不变。
 */
export function withLocalizedHosts(
  html: string,
  values: Readonly<Record<string, unknown>>,
  defaults: ReadonlyMap<string, unknown>,
): string {
  const hosts = [...elementsOf(parse(html, { sourceCodeLocationInfo: true }))].filter((element) =>
    element.attrs.some((attr) => attr.name === LOCALE_BINDINGS),
  )
  const attribute = (index: number, name: string) =>
    hosts[index]?.attrs.find((attr) => attr.name === name)?.value
  const localized = localizedHostValues(
    hosts.map((_, index) => ({
      id: String(index),
      values: variableValuesOf(attribute(index, VALUES_ATTRIBUTE) ?? '{}') ?? {},
      bindings: localeBindingsOf(attribute(index, LOCALE_BINDINGS)),
    })),
    values,
    defaults,
  )
  const edits: SourceEdit[] = []
  for (const [index, next] of localized) {
    const host = hosts[Number(index)]
    const location = host?.sourceCodeLocation
    if (host === undefined || location?.startTag === undefined) continue
    const text = attributeText(VALUES_ATTRIBUTE, JSON.stringify(next))
    const at = location.attrs?.[VALUES_ATTRIBUTE]
    // 宿主未声明取值属性时，紧接开始标签名后插入
    const after = location.startTag.startOffset + 1 + host.tagName.length
    edits.push(
      at === undefined
        ? { from: after, to: after, text: ` ${text}` }
        : { from: at.startOffset, to: at.endOffset, text },
    )
  }
  return applyEdits(html, edits)
}

type Element = DefaultTreeAdapterTypes.Element

/** 移除 `[from, to)` 区间源码（元素或属性）时一并清除其前导空白。 */
const withLeadingSpace = (html: string, from: number, to: number) => {
  let start = from
  while (start > 0 && /\s/.test(html[start - 1] ?? '')) start -= 1
  return { from: start, to }
}

const attributesOf = (element: Element): Record<string, string> =>
  Object.fromEntries(element.attrs.map((attr) => [attr.name, attr.value]))

/** 主文件 `main` 的字幕宿主挂载的字幕场景文件的内容；没有宿主或工程里没有这个文件时是 null。 */
function captionsSceneIn(files: readonly ProjectFile[], main: string): string | null {
  const root = compositionRootOf(parse(main))
  const host = root?.childNodes.find(
    (node): node is Element => 'tagName' in node && isCaptionsHost(attributesOf(node)),
  )
  const path = host === undefined ? undefined : attributesOf(host)['data-composition-src']
  return files.find((file) => file.path === path)?.content ?? null
}

/** 字幕场景 `scene` 里的各句：编号和它写的视频片段（`data-caption-of`，没写是 null）。 */
const captionOwnersIn = (scene: string | null) =>
  scene === null
    ? []
    : [...elementsOf(parse(scene))].flatMap((element) => {
        const { id, [CAPTION_OWNER]: owner } = attributesOf(element)
        return id === undefined || !element.attrs.some((attr) => attr.name === 'data-var-text')
          ? []
          : [{ id, owner: owner === undefined || owner === '' ? null : owner }]
      })

/**
 * 按目标语言 `locale`（原文为 null）改写主文件中的人声轨道：规则见 `localizedVoices`（与预览共用），
 * 移除不出声的配音片段，配音模式下关闭原声；仅修改涉及元素，其余内容保持不变。`scene` 是字幕场景文件的
 * 内容（没有时是 null），用来分出旁白（不属于视频片段的字幕的原文配音）。
 */
export function withLocalizedVoices(
  html: string,
  locale: ExportLocale | null,
  scene: string | null,
): string {
  const root = compositionRootOf(parse(html, { sourceCodeLocationInfo: true }))
  if (root === undefined) return html
  const children = root.childNodes.filter((node): node is Element => 'tagName' in node)
  const elements = children.map((child) => ({
    tag: child.tagName,
    attributes: attributesOf(child),
  }))
  const videos = elements.flatMap(({ tag, attributes }) =>
    tag === 'video' && attributes['id'] !== undefined ? [attributes['id']] : [],
  )
  const changes = localizedVoices(
    elements,
    voiceModesOf(root.attrs.find((attr) => attr.name === VOICE_MODES)?.value),
    locale,
    ownedCaptions(captionOwnersIn(scene), videos),
  )
  const edits: SourceEdit[] = []
  for (const change of changes) {
    const child = children[change.index]
    const location = child?.sourceCodeLocation
    if (child === undefined || location?.startTag === undefined) continue
    if (change.remove) {
      edits.push({ text: '', ...withLeadingSpace(html, location.startOffset, location.endOffset) })
      continue
    }
    // 新增属性追加在开始标签末尾；待移除属性均位于其前方，按位置逆序编辑时不会产生偏移冲突
    const end = location.startTag.endOffset - 1
    const after = html[end - 1] === '/' ? end - 1 : end
    for (const [name, value] of Object.entries(change.attributes)) {
      const at = location.attrs?.[name]
      if (value === null) {
        if (at !== undefined)
          edits.push({ text: '', ...withLeadingSpace(html, at.startOffset, at.endOffset) })
      } else if (at === undefined)
        edits.push({ from: after, to: after, text: ` ${attributeText(name, value)}` })
      else edits.push({ from: at.startOffset, to: at.endOffset, text: attributeText(name, value) })
    }
  }
  return applyEdits(html, edits)
}

/**
 * 完成语言本地化后的导出工程：包含已改写主文件的工程文件列表、传入渲染器的变量值表（原文为 null）
 * 及从值表中剔除的未声明变量条数。
 */
export interface LocalizedProject {
  files: ProjectFile[]
  variables: Record<string, unknown> | null
  dropped: number
}

const withMain = (files: readonly ProjectFile[], content: string): ProjectFile[] =>
  files.map((file) => (file.path === MAIN_FILE ? { path: file.path, content } : file))

/**
 * 将工程转换为 `locale`（原文为 null）对应的导出版本：按目标语言改写主文件人声轨道（见 `withLocalizedVoices`）；
 * 非原文版本还须读取并校验对应语言值表，并重写多语言宿主取值。要求工程包含主文件。
 */
export function localizeProject(
  files: readonly ProjectFile[],
  locale: ExportLocale | null,
): Checked<LocalizedProject> {
  const main = files.find((file) => file.path === MAIN_FILE)?.content ?? ''
  const scene = captionsSceneIn(files, main)
  if (locale === null)
    return {
      ok: true,
      value: {
        files: withMain(files, withLocalizedVoices(main, null, scene)),
        variables: null,
        dropped: 0,
      },
    }
  const table = readLocaleTable(files, locale)
  if (!table.ok) return table
  const declarations = rootDeclarations(main)
  const checked = checkLocaleValues(table.value, declarations)
  if (!checked.ok) return checked
  const { values, dropped } = checked.value
  const localizedMain = withLocalizedHosts(
    main,
    values,
    new Map(declarations.map((declaration) => [declaration.id, declaration.default])),
  )
  return {
    ok: true,
    value: {
      files: withMain(files, withLocalizedVoices(localizedMain, locale, scene)),
      variables: values,
      dropped,
    },
  }
}
