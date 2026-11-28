import type { Composition, JsonPatchOp } from '@hyperframes/sdk'
import { captionStyleRuleIn, withCaptionStyleRule } from './composition/captions'
import { PROJECT_MAIN } from './composition/film'
import type { StoredFile, StoredProject } from './final-cut.api'
import {
  LOCALES,
  localeOfPath,
  localePath,
  openValueTable,
  parseLocaleValues,
  type LocaleCode,
  type ValueTable,
} from './locales'
import type { PatchChange } from './undo-history'

/**
 * SDK 打开的一个文件：引擎，和它存出的内容 `content`。内容只在引擎报了改动（编辑、应用补丁）以后才重新存出：
 * 一批操作抛出时 SDK 整批退回、不报改动，退回后的文件和之前一样，但重新存出的字可能不一样（删掉的元素放回去时
 * 旁边的换行没跟回来、去掉又加回的属性换了位置），按存出的字比就会把被拒的编辑当成改动存一版。
 */
type OpenedEngine = { engine: Composition; content: () => string }

/**
 * 打开工程里的文件 `file`（相对工程根的路径），引擎的每次改动带上文件报给 `onChange`。撤销由会话自己管：
 * 关掉 SDK 自带的，撤销重做时应用补丁引起的改动不报。SDK 的编辑引擎只在打开 final-cut 编辑器时才用得到，
 * 单独成块按需加载。
 */
const openEngine = async (
  html: string,
  file: string,
  onChange: (change: PatchChange) => void,
): Promise<OpenedEngine> => {
  const { openComposition, ORIGIN_APPLY_PATCHES } = await import('@hyperframes/sdk')
  const engine = await openComposition(html, { history: false })
  let content: string | null = null
  engine.on('patch', ({ patches, inversePatches, origin }) => {
    content = null
    if (origin !== ORIGIN_APPLY_PATCHES) onChange({ file, patches, inversePatches })
  })
  const keep = file === PROJECT_MAIN ? '' : prologOf(html)
  return { engine, content: () => (content ??= withProlog(keep, engine.serialize())) }
}

const HTML_START = /<html[\s>]/i

/** 完整网页写法的文件 `<html>` 前面那段（文档类型、许可说明之类的注释）；没有 `<html>` 时是空串。 */
const prologOf = (html: string): string => {
  const at = html.search(HTML_START)
  return at < 0 ? '' : html.slice(0, at)
}

/** SDK 存出的网页换回原文件 `<html>` 前面那段：SDK 存出时会丢掉 `<html>` 前的注释。 */
const withProlog = (prolog: string, serialized: string): string => {
  const at = serialized.search(HTML_START)
  return prolog === '' || at < 0 ? serialized : `${prolog}${serialized.slice(at)}`
}

/**
 * 字幕场景里的字幕样式规则（见 `captions.ts` 的 `withCaptionStyleRule`），由会话自己记着：场景的 `<style>` 在
 * `<template>` 里，SDK 改不到它（`setClassStyle` 找不到这个 `<style>`）。`rule` 是规则原文，没有时是 null；
 * `set` 改它并照值表的样子报一条补丁（路径 `CAPTION_STYLE_PATCH`），撤销重做经 `docOps` 打回来。
 */
type CaptionSheet = {
  rule: () => string | null
  set: (rule: string | null) => void
  apply: (patch: JsonPatchOp) => void
  batch: (change: () => void) => void
}

const CAPTION_STYLE_PATCH = '/caption-style'

const openCaptionSheet = (
  rule: string | null,
  onChange: (patches: readonly JsonPatchOp[], inversePatches: readonly JsonPatchOp[]) => void,
): CaptionSheet => {
  let current = rule
  return {
    rule: () => current,
    set: (next) => {
      if (next === current) return
      const before = current
      current = next
      onChange(
        [{ op: 'replace', path: CAPTION_STYLE_PATCH, value: next }],
        [{ op: 'replace', path: CAPTION_STYLE_PATCH, value: before }],
      )
    },
    apply: (patch) => {
      current = typeof patch.value === 'string' ? patch.value : null
    },
    batch: (change) => {
      const before = current
      try {
        change()
      } catch (error) {
        current = before
        throw error
      }
    },
  }
}

/**
 * 打开着的一个工程文件的内容。几种文件的区别都收在这里：主文件、字幕场景用 SDK 打开（`composition`，见
 * `OpenedEngine`；字幕场景另带字幕样式规则 `sheet`，见 `CaptionSheet`，别的是 null），语言值表是 JSON（`values`，
 * 见 `openValueTable`）。保存、冲突、撤销重做都只经 `docOps` 用它们共有的那几样。
 */
type FileDoc =
  | ({ kind: 'composition'; sheet: CaptionSheet | null } & OpenedEngine)
  | { kind: 'values'; table: ValueTable }

/** 每种文件都有的：存出内容、应用撤销重做的补丁、一批操作（里面抛出时整批退回）、关掉。 */
type DocOps = {
  serialize: () => string
  applyPatches: (patches: readonly JsonPatchOp[]) => void
  batch: (change: () => void) => void
  dispose: () => void
}

export const docOps = (doc: FileDoc): DocOps => {
  if (doc.kind === 'values') return doc.table
  const { engine, content, sheet } = doc
  if (sheet === null)
    return {
      serialize: content,
      applyPatches: (patches) => engine.applyPatches(patches),
      batch: (change) => engine.batch(change),
      dispose: () => engine.dispose(),
    }
  return {
    serialize: () => withCaptionStyleRule(content(), sheet.rule()),
    // 一步里可能既有引擎的补丁又有字幕样式规则的，各打各的
    applyPatches: (patches) => {
      const own = patches.filter((patch) => patch.path === CAPTION_STYLE_PATCH)
      const rest = patches.filter((patch) => patch.path !== CAPTION_STYLE_PATCH)
      if (rest.length > 0) engine.applyPatches(rest)
      for (const patch of own) sheet.apply(patch)
    },
    batch: (change) => engine.batch(() => sheet.batch(change)),
    dispose: () => engine.dispose(),
  }
}

/**
 * 按路径打开工程文件 `path`（相对工程根）：语言值表读成值表，别的用 SDK 打开，字幕场景（`scene`）另记下它的
 * 字幕样式规则（见 `CaptionSheet`）；改动带上文件报给 `onChange`。
 */
export const openDoc = async (
  path: string,
  content: string,
  onChange: (change: PatchChange) => void,
  scene: boolean,
): Promise<FileDoc> => {
  const locale = localeOfPath(path)
  if (locale === undefined)
    return {
      kind: 'composition',
      sheet: scene
        ? openCaptionSheet(captionStyleRuleIn(content), (patches, inversePatches) =>
            onChange({ file: path, patches, inversePatches }),
          )
        : null,
      ...(await openEngine(content, path, onChange)),
    }
  const table = openValueTable(parseLocaleValues(content, locale), (patches, inversePatches) =>
    onChange({ file: path, patches, inversePatches }),
  )
  return { kind: 'values', table }
}

/**
 * 会话打开的单个工程文件：`version` 为工作区最新版本号（打开的文件均已落盘，保存按此版本号校验），
 * `saved` 为最近一次保存或加载时的文件内容快照（刚打开尚未同步快照前为 `null`）。
 */
export type OpenFile = { doc: FileDoc; version: number; saved: string | null }

/**
 * 会话打开着的工程：`files` 是路径（相对工程根）到文件，主文件在 `PROJECT_MAIN`。`captionsPath` 是字幕场景
 * 文件的路径（主文件里字幕宿主挂载的那个；没有宿主时是编辑器新建它的位置），文件打开着时在 `files` 里。
 * 各语言的值表在 `locales/<语言>.json`。
 */
export type Project = { files: Map<string, OpenFile>; captionsPath: string }

export const engineAt = (project: Project, path: string): Composition | undefined => {
  const doc = project.files.get(path)?.doc
  return doc?.kind === 'composition' ? doc.engine : undefined
}

export const mainOf = (project: Project): Composition => {
  const main = engineAt(project, PROJECT_MAIN)
  if (main === undefined) throw new Error('final-cut 工程里没有打开主文件')
  return main
}

export const sceneOf = (project: Project): Composition | undefined =>
  engineAt(project, project.captionsPath)

/** 字幕场景的字幕样式规则（见 `CaptionSheet`）；还没有字幕场景时是 undefined。 */
export const sheetOf = (project: Project): CaptionSheet | undefined => {
  const doc = project.files.get(project.captionsPath)?.doc
  return doc?.kind === 'composition' ? (doc.sheet ?? undefined) : undefined
}

/** 打开着的文件 `path`（相对工程根）现在的内容（见 `OpenedEngine`）。 */
export const contentOf = (project: Project, path: string): string => {
  const file = project.files.get(path)
  if (file === undefined) throw new Error(`final-cut 工程里没有打开 ${path}`)
  return docOps(file.doc).serialize()
}

/** 工程里各语言的值表，按 `LOCALES` 的先后。 */
export const tablesOf = (project: Project): Map<LocaleCode, ValueTable> => {
  const tables = new Map<LocaleCode, ValueTable>()
  for (const { code } of LOCALES) {
    const doc = project.files.get(localePath(code))?.doc
    if (doc?.kind === 'values') tables.set(code, doc.table)
  }
  return tables
}

export const disposeAll = (project: Project | null) => {
  for (const file of project?.files.values() ?? []) docOps(file.doc).dispose()
}

/** 有没有没存的文件：`present` 是各文件现在的内容。 */
export const unsaved = (project: Project | null, present: ReadonlyMap<string, string>) =>
  [...(project?.files ?? [])].some(([path, file]) => present.get(path) !== file.saved)

/**
 * 工作区里存着的各文件（路径相对工程根 → 文件，不存在的是 null）：主文件、字幕场景和各语言值表。
 */
export const storedFilesOf = (stored: StoredProject | null): Map<string, StoredFile | null> =>
  new Map<string, StoredFile | null>(
    stored === null
      ? []
      : [
          [PROJECT_MAIN, stored.main],
          [stored.captionsPath, stored.captions],
          ...[...stored.locales].map(([code, file]) => [localePath(code), file] as const),
        ],
  )
