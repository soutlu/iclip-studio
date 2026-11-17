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
  localizedVoices,
  VOICE_MODES,
  voiceModesOf,
} from '../../web/src/features/storyboard/final-cut/composition/voices'
import {
  applyEdits,
  attributeText,
  elementsOf,
  MAIN_FILE,
  type ProjectFile,
  type SourceEdit,
} from './project'
import type { ExportLocale } from './request'

/**
 * 按语言导出：final-cut 的原文是视频自带的语言（主文件根上变量的默认值，没有值表），能加的每种语言一份值表
 * `locales/<语言>.json`（变量 id → 这种语言的值）。导出一种语言时规则和编辑器预览这种语言一样：字幕的字是主文件
 * 根上的变量，值交给渲染器；贴片、场景里随语言的字段由 `localizedHostValues`（和预览同一个函数）并进宿主的
 * `data-variable-values`；人声由 `localizedVoices`（也和预览同一个函数）定，原文也要用它去掉配音片段。
 */

/** 成功时的结果，或说明哪里不对的一句话（会给用户看，不带值表里的字）。 */
export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

const VALUES_ATTRIBUTE = 'data-variable-values'

/** 一种语言的值表在工程里的路径（相对工程根）。 */
export const localePath = (locale: ExportLocale) => `locales/${locale}.json`

/** 从工程文件里读 `locale` 的值表：要有这个文件，内容是一个 JSON 对象。 */
export function readLocaleTable(
  files: readonly ProjectFile[],
  locale: ExportLocale,
): Checked<Record<string, unknown>> {
  const file = files.find((candidate) => candidate.path === localePath(locale))
  if (file === undefined)
    return {
      ok: false,
      message: 'final-cut 里没有这种语言的语言文件，无法导出这种语言的版本',
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
        '这种语言的语言文件写法不对，无法导出这种语言的版本；请把它改成变量 id 对应文字的 JSON 对象后再导出',
    }
  return { ok: true, value: { ...(parsed as Record<string, unknown>) } }
}

/**
 * 主文件根（`<html>`）上 `data-composition-variables` 声明的变量。写法不对的声明不算，整个属性写法不对时
 * 当作没有声明：和引擎读声明的规则一样（同一个 `isCompositionVariable`）。
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
 * 按主文件根上的声明校验值表：没声明的变量去掉（答复去掉了几条），有一个值的类型和声明的不对（或不在
 * 可选范围里）就整份不用。
 */
export function checkLocaleValues(
  values: Readonly<Record<string, unknown>>,
  declarations: readonly CompositionVariable[],
): Checked<{ values: Record<string, unknown>; dropped: number }> {
  const issues = validateVariables({ ...values }, declarations)
  const wrong = issues.find((issue) => issue.kind !== 'undeclared')
  if (wrong !== undefined) {
    const declared = declarations.find((declaration) => declaration.id === wrong.variableId)
    const expected = declared === undefined ? '' : `，应当是${TYPE_NAMES[declared.type]}`
    return {
      ok: false,
      message: `这种语言的语言文件里变量 ${wrong.variableId} 的值不对${expected}，无法导出这种语言的版本；请在编辑器里改好这种语言的文字后再导出`,
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
 * 主文件里贴片、场景的宿主换成一种语言的取值：只重写有随语言字段（`data-locale-bindings`）的宿主的
 * `data-variable-values`，规则见 `localizedHostValues`（`values` 是校验过的值表，`defaults` 是根上变量的
 * 默认值）。字幕宿主、没有随语言字段的宿主不动，别的字一个不动。
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
    // 宿主上没写取值时加在标签名后面
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

/** 去掉 `[from, to)` 这段源码（一个元素或属性）时连同它前面的空白一起去掉。 */
const withLeadingSpace = (html: string, from: number, to: number) => {
  let start = from
  while (start > 0 && /\s/.test(html[start - 1] ?? '')) start -= 1
  return { from: start, to }
}

/**
 * 主文件按导出的语言 `locale`（原文是 null）放人声：规则见 `localizedVoices`（和预览同一个函数），别的语言的
 * 配音片段去掉，AI 配音时原声关掉。只改要改的元素，别的字一个不动。
 */
export function withLocalizedVoices(html: string, locale: ExportLocale | null): string {
  const root = [...elementsOf(parse(html, { sourceCodeLocationInfo: true }))].find((element) =>
    element.attrs.some((attr) => attr.name === 'data-composition-id'),
  )
  if (root === undefined) return html
  const children = root.childNodes.filter((node): node is Element => 'tagName' in node)
  const changes = localizedVoices(
    children.map((child) => ({
      tag: child.tagName,
      attributes: Object.fromEntries(child.attrs.map((attr) => [attr.name, attr.value])),
    })),
    voiceModesOf(root.attrs.find((attr) => attr.name === VOICE_MODES)?.value),
    locale,
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
    // 新加的属性写在开始标签的结尾：去掉的属性都在它前面，按位置倒着改时不会挪动它们
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
 * 按 `locale` 导出时交给渲染的：改好主文件的工程文件、给渲染器的变量值（原文时是 null），和值表里去掉了几条
 * 没声明的。
 */
export interface LocalizedProject {
  files: ProjectFile[]
  variables: Record<string, unknown> | null
  dropped: number
}

const withMain = (files: readonly ProjectFile[], content: string): ProjectFile[] =>
  files.map((file) => (file.path === MAIN_FILE ? { path: file.path, content } : file))

/**
 * 把工程变成 `locale`（原文是 null）的版本：主文件按这种语言放人声（见 `withLocalizedVoices`）；原文以外的语言
 * 还要读值表、按主文件根上的声明校验、改宿主取值。工程要有主文件。
 */
export function localizeProject(
  files: readonly ProjectFile[],
  locale: ExportLocale | null,
): Checked<LocalizedProject> {
  const main = files.find((file) => file.path === MAIN_FILE)?.content ?? ''
  if (locale === null)
    return {
      ok: true,
      value: {
        files: withMain(files, withLocalizedVoices(main, null)),
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
      files: withMain(files, withLocalizedVoices(localizedMain, locale)),
      variables: values,
      dropped,
    },
  }
}
