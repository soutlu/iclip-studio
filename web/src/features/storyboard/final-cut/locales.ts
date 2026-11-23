import type { JsonPatchOp } from '@hyperframes/sdk'
import { UserFacingError } from '@/shared/api/client'

/**
 * final-cut 支持添加的语言列表（各自对应 `locales/<code>.json` 值表）：`name` 为界面展示名，`tag` 为按钮缩写代码。
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
 * 原文标识：代表视频原生语言（无需预先声明）。主文件根节点变量的默认值即原文内容，不单独生成值表文件。
 * 编辑器内部与导出接口均以 `null` 表示原文。
 */
export const SOURCE_LOCALE = null

/** 原文在界面与语言切换按钮上的显示名称。 */
export const SOURCE_NAME = '原文'

/** 编辑器可选语言：原文或已支持的译文语言代码。 */
export type Language = LocaleCode | typeof SOURCE_LOCALE

const localeNamed = (code: LocaleCode) =>
  LOCALES.find((locale) => locale.code === code) ?? LOCALES[0]

/** 获取语言的界面显示名称：原文返回「原文」，其余返回 `LOCALES` 中定义的名称。 */
export const languageName = (code: Language): string =>
  code === SOURCE_LOCALE ? SOURCE_NAME : localeNamed(code).name

const HAN = /\p{Script=Han}/u

/**
 * 将词组嵌入中文句式：西文或数字词组与相邻汉字间补一个空格，邻接标点或位于句首句尾时不补；中文词组不补空格。
 * 例如 `phraseAround('正在提交', '720P', '导出…')` 返回「正在提交 720P 导出…」。
 */
export function phraseAround(before: string, word: string, after: string): string {
  const gap = (neighbor: string) => (!HAN.test(word) && HAN.test(neighbor) ? ' ' : '')
  return `${before}${gap(before.slice(-1))}${word}${gap(after.slice(0, 1))}${after}`
}

/**
 * 将语言名称嵌入中文句式（空格规则见 `phraseAround`）。例如 `phraseWith('导出', 'en', '版')` 返回「导出 English 版」，
 * `phraseWith('导出', 'zh', '版')` 返回「导出中文版」。
 */
export const phraseWith = (before: string, code: LocaleCode, after: string): string =>
  phraseAround(before, localeNamed(code).name, after)

/** 语言值表在工程内的相对路径。 */
export const localePath = (code: LocaleCode) => `locales/${code}.json`

/** 根据工程内相对路径 `path` 识别对应语言代码；非值表路径或不支持的语言返回 `undefined`。 */
export const localeOfPath = (path: string): LocaleCode | undefined =>
  LOCALES.find((locale) => localePath(locale.code) === path)?.code

/** 语言值表映射：变量 ID → 对应语言取值（遵循官方变量值文件规范，值可为任意 JSON 类型）。 */
export type LocaleValues = Readonly<Record<string, unknown>>

/** 读取字幕变量 `variable` 在值表 `values` 中的译文；`values` 为 `null`（原文）或未收录该键时返回 `null`。 */
export const translationOf = (values: LocaleValues | null, variable: string): string | null => {
  const value = values === null || !Object.hasOwn(values, variable) ? undefined : values[variable]
  return typeof value === 'string' ? value : null
}

/**
 * 编辑器当前展示语言状态：原文，或工程内已存在的语言代码及其值表（字幕原文 `CaptionClip.text` 保持不变）。
 */
export type ShownLocale =
  { code: typeof SOURCE_LOCALE; values: null } | { code: LocaleCode; values: LocaleValues }

export const SOURCE_SHOWN: ShownLocale = { code: SOURCE_LOCALE, values: null }

/**
 * 计算字幕在当前展示语言 `shown` 下的编辑态：`text` 为待编辑内容（未翻译时为空串），
 * `untranslated` 标识当前是否因尚未翻译而回退显示原文。
 */
export const captionIn = (
  shown: ShownLocale,
  caption: { text: string; variable: string },
): { text: string; untranslated: boolean } => {
  if (shown.values === null) return { text: caption.text, untranslated: false }
  const translation = translationOf(shown.values, caption.variable)
  return { text: translation ?? '', untranslated: translation === null }
}

/** 解析语言值表 JSON 字符串，校验其为普通 JSON 对象，否则抛出面向用户的格式错误。 */
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

/** 序列化语言值表：2 空格缩进、按键码点排序、末尾换行，保证相同数据输出确定性文本。 */
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

/** 从 JSON Patch 路径提取顶层变量 ID；非顶层路径时抛出错误。 */
export const valueIdOf = (path: string): string => {
  if (!path.startsWith('/') || path.indexOf('/', 1) !== -1)
    throw new Error(`值表的补丁只改顶层的键：${path}`)
  return path.slice(1).replaceAll('~1', '/').replaceAll('~0', '~')
}

/**
 * 打开的语言值表会话（与 SDK 会话采用相同的 JSON Patch 变更模型）：`set` 每次修改顶层键触发 `onChange`（含正向与反向补丁），
 * `applyPatches` 静默应用撤销/重做补丁，`batch` 在回调抛错时回滚至进入前快照。
 */
export type ValueTable = {
  values: () => LocaleValues
  /** 设置 `id` 对应值为 `value`（传入 `null` 表示删除该键）；无变更时不触发回调。 */
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
