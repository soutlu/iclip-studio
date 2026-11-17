import type { JsonPatchOp } from '@hyperframes/sdk'
import { UserFacingError } from '@/shared/api/client'

/**
 * final-cut 能加的语言，各有一份值表 `locales/<code>.json`。`name` 是界面上写的名字，`tag` 是语言按钮上的代码。
 */
export const LOCALES = [
  { code: 'zh', name: '中文', tag: 'ZH' },
  { code: 'en', name: 'English', tag: 'EN' },
  { code: 'de', name: 'Deutsch', tag: 'DE' },
  { code: 'es', name: 'Español', tag: 'ES' },
  { code: 'fr', name: 'Français', tag: 'FR' },
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']

/**
 * 原文：视频自带的语言，什么语言都行，不用声明。主文件根上声明的变量默认值就是原文的字，没有值表。编辑器里
 * 原文的语言写作 null，导出接口里也是 null。
 */
export const SOURCE_LOCALE = null

/** 界面上原文的名字，也是语言切换里原文按钮上的字。 */
export const SOURCE_NAME = '原文'

/** 编辑器里的一种语言：原文，或能加的一种语言。 */
export type Language = LocaleCode | typeof SOURCE_LOCALE

const localeNamed = (code: LocaleCode) =>
  LOCALES.find((locale) => locale.code === code) ?? LOCALES[0]

const HAN = /\p{Script=Han}/u

/**
 * 把语言名接进中文句子：西文的名字和挨着的汉字之间留一个空格，挨着标点、句首句尾不留；中文的名字不留。例如
 * `phraseWith('导出', 'en', '版')` 是「导出 English 版」，`phraseWith('导出', 'zh', '版')` 是「导出中文版」。
 */
export function phraseWith(before: string, code: LocaleCode, after: string): string {
  const { name } = localeNamed(code)
  const gap = (neighbor: string) => (!HAN.test(name) && HAN.test(neighbor) ? ' ' : '')
  return `${before}${gap(before.slice(-1))}${name}${gap(after.slice(0, 1))}${after}`
}

/** 语言值表在工程里的路径（相对工程根）。 */
export const localePath = (code: LocaleCode) => `locales/${code}.json`

/** 工程里的路径 `path`（相对工程根）是哪种语言的值表；不是值表、或是不认识的语言时是 undefined。 */
export const localeOfPath = (path: string): LocaleCode | undefined =>
  LOCALES.find((locale) => localePath(locale.code) === path)?.code

/** 一份值表里的值：变量 id → 这种语言的值（照官方的变量值文件，值可以是任意 JSON）。 */
export type LocaleValues = Readonly<Record<string, unknown>>

/** 一句字幕（读变量 `variable`）在值表 `values` 里的字；`values` 是 null（原文）或没写这句时是 null。 */
export const translationOf = (values: LocaleValues | null, variable: string): string | null => {
  const value = values === null || !Object.hasOwn(values, variable) ? undefined : values[variable]
  return typeof value === 'string' ? value : null
}

/**
 * 编辑器当前显示的语言：原文，或工程里有值表的一种语言和它的值表。字幕的原文（`CaptionClip.text`）不跟着
 * 语言变。
 */
export type ShownLocale =
  { code: typeof SOURCE_LOCALE; values: null } | { code: LocaleCode; values: LocaleValues }

export const SOURCE_SHOWN: ShownLocale = { code: SOURCE_LOCALE, values: null }

/**
 * 一句字幕在 `shown` 这种语言下的样子：`text` 是要编辑的字（其它语言里还没翻时是空的），`untranslated` 是其它
 * 语言里还没翻、显示的是原文。
 */
export const captionIn = (
  shown: ShownLocale,
  caption: { text: string; variable: string },
): { text: string; untranslated: boolean } => {
  if (shown.values === null) return { text: caption.text, untranslated: false }
  const translation = translationOf(shown.values, caption.variable)
  return { text: translation ?? '', untranslated: translation === null }
}

/** 值表的内容：一个 JSON 对象。不是这样时说明原因。 */
export function parseLocaleValues(content: string, code: LocaleCode): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new UserFacingError(
      phraseWith(
        '',
        code,
        '的语言文件写法不对，无法打开 final-cut；请把它改成变量 id 对应文字的 JSON 对象',
      ),
    )
  return { ...(parsed as Record<string, unknown>) }
}

/** 值表存出的样子：缩进 2 格，键按字符编码排，结尾换行；同样的值总是写出同样的字。 */
export function localeValuesFile(values: LocaleValues): string {
  const entries = Object.entries(values).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  if (entries.length === 0) return '{}\n'
  const lines = entries.map(
    ([id, value]) =>
      `  ${JSON.stringify(id)}: ${(JSON.stringify(value, null, 2) ?? 'null').replaceAll('\n', '\n  ')}`,
  )
  return `{\n${lines.join(',\n')}\n}\n`
}

const pointer = (id: string) => `/${id.replaceAll('~', '~0').replaceAll('/', '~1')}`

/** 值表补丁的路径 `path` 改的是哪个变量；不是顶层的键时抛错。 */
export const valueIdOf = (path: string): string => {
  if (!path.startsWith('/') || path.indexOf('/', 1) !== -1)
    throw new Error(`值表的补丁只改顶层的键：${path}`)
  return path.slice(1).replaceAll('~1', '/').replaceAll('~0', '~')
}

/**
 * 打开着的一份值表，和 SDK 会话一样用补丁记改动：`set` 每改一个键报一次 `onChange`（补丁和反向补丁，只动顶层的键），
 * `applyPatches` 应用撤销重做的补丁、不报。`batch` 里抛出时值退回进去之前的样子。
 */
export type ValueTable = {
  values: () => LocaleValues
  /** 把 `id` 的值改成 `value`，null 是从值表里去掉；没变时什么都不报。 */
  set: (id: string, value: string | null) => void
  batch: (change: () => void) => void
  applyPatches: (patches: readonly JsonPatchOp[]) => void
  serialize: () => string
  dispose: () => void
}

export function openValueTable(
  values: Record<string, unknown>,
  onChange: (patches: readonly JsonPatchOp[], inversePatches: readonly JsonPatchOp[]) => void,
): ValueTable {
  let current = { ...values }
  return {
    values: () => ({ ...current }),
    set: (id, value) => {
      const path = pointer(id)
      const had = Object.hasOwn(current, id)
      const before = current[id]
      if (value === null) {
        if (!had) return
        delete current[id]
        onChange([{ op: 'remove', path }], [{ op: 'add', path, value: before }])
        return
      }
      if (had && before === value) return
      current[id] = value
      onChange(
        [{ op: had ? 'replace' : 'add', path, value }],
        [had ? { op: 'replace', path, value: before } : { op: 'remove', path }],
      )
    },
    batch: (change) => {
      const before = { ...current }
      try {
        change()
      } catch (error) {
        current = before
        throw error
      }
    },
    applyPatches: (patches) => {
      const next = { ...current }
      for (const patch of patches) {
        const id = valueIdOf(patch.path)
        if (patch.op === 'remove') delete next[id]
        else next[id] = patch.value
      }
      current = next
    },
    serialize: () => localeValuesFile(current),
    dispose: () => undefined,
  }
}
