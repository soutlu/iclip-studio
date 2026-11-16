import { use, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { writeClipTiming } from '@hyperframes/core/composition-contract'
import { mintLinkId, relinkSplitHalves } from '@hyperframes/core/media-link'
import type { Composition, ElementSnapshot, JsonPatchOp } from '@hyperframes/sdk'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import {
  CAPTION_FOLLOW_REFUSAL_TEXT,
  captionsFollowing,
  splitOwners,
  type NewCaption,
} from './caption-edit'
import { rippleStarts, withLinkedStarts, type Cut, type Links, type Timing } from './clip-edit'
import {
  CAPTION_OWNER,
  CAPTIONS_PATH,
  captionElement,
  captionLabel,
  captionOf,
  captionsHostElement,
  captionsProblem,
  captionsScene,
  captionVariable,
  isCaptionsHost,
} from './composition/captions'
import type {
  CatalogItem,
  CatalogVariable,
  ComponentCatalog,
  VariableValue,
} from './composition/catalog'
import {
  audioElement,
  clipOf,
  emptyProject,
  hostElement,
  itemFonts,
  itemNamed,
  PROJECT_MAIN,
  videoElement,
  withFontBlock,
  type AudioClip,
  type Canvas,
  type CaptionClip,
  type ClipAttribute,
  type FilmClip,
  type HostClip,
  type VideoClip,
} from './composition/film'
import {
  fieldText,
  LOCALE_BINDINGS,
  localeBindingsAttribute,
  localeBindingsOf,
  localeVariable,
  localeVariableId,
  pinnedByDefault,
  textFields,
  type LocaleBindings,
} from './composition/locale-text'
import {
  copyItemFiles,
  createProjectFile,
  holdProjectReads,
  PROJECT_DIR,
  PROJECT_MAIN_PATH,
  projectLocaleOf,
  readLocaleFile,
  readProject,
  readProjectFile,
  writeProjectFile,
  type StoredFile,
  type StoredProject,
} from './final-cut.api'
import { itemDurationMs } from './items'
import {
  LOCALES,
  localeOfPath,
  localePath,
  localeValuesFile,
  openValueTable,
  parseLocaleValues,
  SOURCE_LOCALE,
  translationOf,
  type LocaleCode,
  type ShownLocale,
  type ValueTable,
} from './locales'
import type { AttributeChanges } from './original-sound'
import { onRow, topTrack, voiceRowFor, type Landing, type Renumbering } from './placement'
import { detachedVideoChanges, mergedVideoChanges, type SoundPair } from './sound-pair'
import { newClipZ, restackedZ } from './stacking'
import { createUndoHistory, type PatchChange, type UndoHistory } from './undo-history'
import type { StackingDirection } from './vendor/hyperframes-studio/player/components/timelineStackingSync'

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; message: string }

/** 工程现在的样子：`html` 是当前的主文件（没存的改动也在里面），其余是从工程里的文件读出来的。 */
export type FilmView = {
  html: string
  canvas: Canvas
  /**
   * 主文件根下所有带时间的元素（字幕宿主除外），按它们在文件里的先后；后面跟着字幕场景里的各句字幕，
   * 按它们在场景里的先后。
   */
  clips: readonly FilmClip[]
  /** 带链接（`data-link`）的片段各自的链接名。 */
  links: Links
  durationMs: number
  /** 字幕写法不对时的原因（见 `captionsProblem`），导出前要先改好。 */
  captionsProblem: string | undefined
  /**
   * 当前显示的语言和它的值表（中文时是 null）。`clips` 里字幕的 `text` 总是原文，名字取这种语言的字
   * （还没翻的取原文）；预览按值表套上这种语言。
   */
  locale: ShownLocale
  /** 工程里有值表的外语，按 `LOCALES` 的先后。 */
  locales: readonly LocaleCode[]
  /** 组件或块的片段里随语言的文字字段（片段编号 → 字段到根变量），没有随语言字段的片段不在里面。 */
  bindings: ReadonlyMap<string, LocaleBindings>
  canUndo: boolean
  canRedo: boolean
}

/** 要放进工程的一段素材；起点由现有内容决定，接在画面那一行的末尾。 */
export type NewVideo = Pick<VideoClip, 'label' | 'src' | 'mediaStart' | 'duration' | 'muted'>

/** 要放进工程的一段音频：一条音频记录从 `mediaStart` 起的 `duration` 毫秒。 */
export type NewAudio = Pick<AudioClip, 'label' | 'src' | 'mediaStart' | 'duration'>

/**
 * 打开工程里的文件 `file`（相对工程根的路径），引擎的每次改动带上文件报给 `onChange`。撤销由会话自己管：
 * 关掉 SDK 自带的，撤销重做时应用补丁引起的改动不报。SDK 的编辑引擎只在打开 final-cut 编辑器时才用得到，
 * 单独成块按需加载。
 */
const openEngine = async (
  html: string,
  file: string,
  onChange: (change: PatchChange) => void,
): Promise<Composition> => {
  const { openComposition, ORIGIN_APPLY_PATCHES } = await import('@hyperframes/sdk')
  const engine = await openComposition(html, { history: false })
  engine.on('patch', ({ patches, inversePatches, origin }) => {
    if (origin !== ORIGIN_APPLY_PATCHES) onChange({ file, patches, inversePatches })
  })
  return engine
}

/**
 * 打开着的一个工程文件的内容。几种文件的区别都收在这里：主文件、字幕场景用 SDK 打开（`composition`），语言值表
 * 是 JSON（`values`，见 `openValueTable`）。保存、冲突、撤销重做都只经 `docOps` 用它们共有的那几样。
 */
type FileDoc = { kind: 'composition'; engine: Composition } | { kind: 'values'; table: ValueTable }

/** 每种文件都有的：存出内容、应用撤销重做的补丁、一批操作（里面抛出时整批退回）、关掉。 */
type DocOps = {
  serialize: () => string
  applyPatches: (patches: readonly JsonPatchOp[]) => void
  batch: (change: () => void) => void
  dispose: () => void
}

const docOps = (doc: FileDoc): DocOps => (doc.kind === 'composition' ? doc.engine : doc.table)

/** 按路径打开工程文件 `path`（相对工程根）：语言值表读成值表，别的用 SDK 打开；改动带上文件报给 `onChange`。 */
const openDoc = async (
  path: string,
  content: string,
  onChange: (change: PatchChange) => void,
): Promise<FileDoc> => {
  const locale = localeOfPath(path)
  if (locale === undefined)
    return { kind: 'composition', engine: await openEngine(content, path, onChange) }
  const table = openValueTable(parseLocaleValues(content, locale), (patches, inversePatches) =>
    onChange({ file: path, patches, inversePatches }),
  )
  return { kind: 'values', table }
}

/**
 * 会话打开着的一个工程文件：`version` 是工作区里的版本号（新建工程还没存过的主文件是 null，第一次保存走新建），
 * `saved` 是最近一次存下或读到的内容（还没存过时是 null）。
 */
type OpenFile = { doc: FileDoc; version: number | null; saved: string | null }

/**
 * 会话打开着的工程：`files` 是路径（相对工程根）到文件，主文件在 `PROJECT_MAIN`。`captionsPath` 是字幕场景
 * 文件的路径（主文件里字幕宿主挂载的那个；没有宿主时是编辑器新建它的位置），文件打开着时在 `files` 里。
 * 各外语的值表在 `locales/<语言>.json`。
 */
type Project = { files: Map<string, OpenFile>; captionsPath: string }

const engineAt = (project: Project, path: string): Composition | undefined => {
  const doc = project.files.get(path)?.doc
  return doc?.kind === 'composition' ? doc.engine : undefined
}

const mainOf = (project: Project): Composition => {
  const main = engineAt(project, PROJECT_MAIN)
  if (main === undefined) throw new Error('final-cut 工程里没有打开主文件')
  return main
}

const sceneOf = (project: Project): Composition | undefined =>
  engineAt(project, project.captionsPath)

/** 工程里各外语的值表，按 `LOCALES` 的先后。 */
const tablesOf = (project: Project): Map<LocaleCode, ValueTable> => {
  const tables = new Map<LocaleCode, ValueTable>()
  for (const { code } of LOCALES) {
    const doc = project.files.get(localePath(code))?.doc
    if (doc?.kind === 'values') tables.set(code, doc.table)
  }
  return tables
}

const disposeAll = (project: Project | null) => {
  for (const file of project?.files.values() ?? []) docOps(file.doc).dispose()
}

/** 有没有没存的文件：`present` 是各文件现在的内容。 */
const unsaved = (project: Project | null, present: ReadonlyMap<string, string>) =>
  [...(project?.files ?? [])].some(([path, file]) => present.get(path) !== file.saved)

const STALE_NOTICE = 'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃'
const CAPTIONS_MISSING_TEXT = '字幕文件不存在，已按没有字幕打开 final-cut'

const STEP_FAILED_TEXT = {
  undo: '撤销失败，已清空撤销记录',
  redo: '重做失败，已清空撤销记录',
} as const

const NO_RENUMBERING: Renumbering = new Map()
const NO_STARTS: ReadonlyMap<string, number> = new Map()

/** 文件的根：最外层带 `data-composition-id` 的元素（主文件的根、字幕场景的根）。 */
const rootOf = (engine: Composition): ElementSnapshot | undefined =>
  engine
    .getRootElements()
    .find((element) => element.attributes['data-composition-id'] !== undefined)

/** 主文件里的字幕宿主。 */
const captionsHostOf = (main: Composition): ElementSnapshot | undefined =>
  rootOf(main)?.children.find((element) => isCaptionsHost(element.attributes))

const canvasOf = (main: Composition): Canvas => {
  const root = rootOf(main)
  return {
    width: Number(root?.attributes['data-width'] ?? 0),
    height: Number(root?.attributes['data-height'] ?? 0),
  }
}

/**
 * 主文件根下所有带时间的元素（字幕宿主除外）读成的片段，按它们在文件里的先后。不存出文件，一批操作中间也能用。
 */
const clipsOf = (main: Composition, catalog: ComponentCatalog): FilmClip[] => {
  const timings = main.getElementTimings()
  return (rootOf(main)?.children ?? []).flatMap((element) => {
    const timing = timings[element.id]
    return timing === undefined || isCaptionsHost(element.attributes)
      ? []
      : [clipOf(element, timing, catalog)]
  })
}

/**
 * 字幕场景根下的各句字幕，按它们在场景里的先后；字取主文件根上的变量。字幕宿主隐藏着时每句都算隐藏
 * （预览和导出里都不出现）。
 */
const captionsIn = (scene: Composition, main: Composition): CaptionClip[] => {
  const texts = new Map(
    main
      .getVariableDeclarations()
      .flatMap((declaration) =>
        typeof declaration.default === 'string' ? [[declaration.id, declaration.default]] : [],
      ),
  )
  const hostHidden = captionsHostOf(main)?.attributes['data-hidden'] !== undefined
  const timings = scene.getElementTimings()
  return (rootOf(scene)?.children ?? []).flatMap((element) => {
    const timing = timings[element.id]
    if (timing === undefined) return []
    const caption = captionOf(element, timing, texts)
    return [{ ...caption, hidden: caption.hidden || hostHidden }]
  })
}

/** 主文件里的片段和字幕场景里的各句字幕（见 `FilmView.clips`）。 */
const allClipsOf = (
  main: Composition,
  scene: Composition | undefined,
  catalog: ComponentCatalog,
): FilmClip[] => [
  ...clipsOf(main, catalog),
  ...(scene === undefined ? [] : captionsIn(scene, main)),
]

/** 各句字幕，编号 → 字幕；还没有字幕场景时是空的。 */
const captionsById = (main: Composition, scene: Composition | undefined) =>
  new Map(
    (scene === undefined ? [] : captionsIn(scene, main)).map((caption) => [caption.id, caption]),
  )

/** 片段 `id` 写在哪个文件里：字幕（`captions` 里的）在字幕场景里，别的在主文件里。 */
const fileOf = (
  main: Composition,
  scene: Composition | undefined,
  captions: ReadonlyMap<string, CaptionClip>,
  id: string,
): Composition => (scene !== undefined && captions.has(id) ? scene : main)

const declares = (main: Composition, variable: string) =>
  main.getVariableDeclarations().some((declaration) => declaration.id === variable)

/** 主文件根上的变量现在的默认值；没声明时是 undefined。 */
const declaredDefault = (main: Composition, variable: string) =>
  main.getVariableDeclarations().find((declaration) => declaration.id === variable)?.default

/** 主文件根上的变量 `variable` 的默认值写成 `text`，还没声明时声明上（名字是 `label`）。 */
const writeDefault = (main: Composition, variable: string, label: string, text: string) => {
  if (!declares(main, variable)) main.declareVariable(localeVariable(variable, label, text))
  else if (declaredDefault(main, variable) !== text) main.setVariableValue(variable, text)
}

/** 片段 `id` 上随语言的字段（见 `LOCALE_BINDINGS`）。 */
const bindingsOf = (main: Composition, id: string): LocaleBindings =>
  localeBindingsOf(main.getElement(id)?.attributes[LOCALE_BINDINGS])

const writeBindings = (main: Composition, id: string, bindings: LocaleBindings) =>
  main.setAttribute(id, LOCALE_BINDINGS, localeBindingsAttribute(bindings))

/** 组件或块的片段 `clip` 的文字字段 `field` 改成随语言：根上声明变量（默认值是现在的字），宿主上记下。 */
const followLocale = (
  main: Composition,
  clip: Pick<HostClip, 'id' | 'values'>,
  field: CatalogVariable,
) => {
  const bindings = bindingsOf(main, clip.id)
  if (bindings[field.id] !== undefined) return
  const variable = localeVariableId(clip.id, field.id)
  writeDefault(main, variable, field.label, fieldText(clip.values, field))
  writeBindings(main, clip.id, { ...bindings, [field.id]: variable })
}

/** 片段 `id` 的字段 `fieldId` 改成固定：去掉宿主上的记录、根上的变量和各语言值表里它的值。 */
const pinField = (main: Composition, tables: Iterable<ValueTable>, id: string, fieldId: string) => {
  const { [fieldId]: variable, ...rest } = bindingsOf(main, id)
  if (variable === undefined) return
  writeBindings(main, id, rest)
  if (declares(main, variable)) main.removeVariableDeclaration(variable)
  for (const table of tables) table.set(variable, null)
}

/** 片段 `clip` 按默认规则（见 `pinnedByDefault`）该随语言、现在还固定着的文字字段。 */
const followingByDefault = (
  main: Composition,
  clip: Pick<HostClip, 'id' | 'values'>,
  item: CatalogItem,
): CatalogVariable[] =>
  textFields(item).filter(
    (field) =>
      !pinnedByDefault(fieldText(clip.values, field)) &&
      bindingsOf(main, clip.id)[field.id] === undefined,
  )

/** 工程总长（毫秒）：主文件根下的片段（字幕宿主除外）和各句字幕里最晚的结尾。 */
const latestEnd = (main: Composition, scene: Composition | undefined): number => {
  const skipped = new Set([rootOf(main)?.id, captionsHostOf(main)?.id])
  const ends = (engine: Composition) =>
    Object.entries(engine.getElementTimings())
      .filter(([id]) => !skipped.has(id))
      .map(([, timing]) => timing.exitAt * 1000)
  if (scene !== undefined) skipped.add(rootOf(scene)?.id)
  return Math.round(Math.max(0, ...ends(main), ...(scene === undefined ? [] : ends(scene))))
}

/** 按现在的样子写总长：根上的总长，字幕宿主的时长跟着一样长。 */
const writeTotal = (main: Composition, scene: Composition | undefined) => {
  const total = latestEnd(main, scene) / 1000
  main.dispatch({ type: 'setCompositionMetadata', duration: total })
  const host = captionsHostOf(main)
  const timing = host === undefined ? undefined : main.getElementTimings()[host.id]
  if (host !== undefined && timing !== undefined && timing.exitAt - timing.enterAt !== total)
    main.setTiming(host.id, { start: 0, duration: total }, { linked: false })
}

/**
 * 工程现在的样子（显示语言 `locale` 的字），和各文件现在的内容（路径 → 内容）：主文件只重算 `<head>` 里的
 * 字体块（SDK 改不了 `<head>`），字按原文和所有值表里的字一起算，存出的内容和显示哪种语言无关；别的文件照
 * 各自存出的写。
 */
const viewOf = (
  project: Project,
  catalog: ComponentCatalog,
  history: UndoHistory,
  locale: LocaleCode,
): { view: FilmView; present: Map<string, string> } => {
  const main = mainOf(project)
  const scene = sceneOf(project)
  const clips = allClipsOf(main, scene, catalog)
  const tables = tablesOf(project)
  const localeText = [...tables.values()]
    .flatMap((table) => Object.values(table.values()))
    .filter((value) => typeof value === 'string')
    .join('')
  const html = withFontBlock(main.serialize(), clips, catalog, localeText)
  const present = new Map(
    [...project.files].map(([path, file]) => [
      path,
      path === PROJECT_MAIN ? html : docOps(file.doc).serialize(),
    ]),
  )
  const shown: ShownLocale = { code: locale, values: tables.get(locale)?.values() ?? null }
  const view: FilmView = {
    html,
    canvas: canvasOf(main),
    clips:
      shown.values === null
        ? clips
        : clips.map((clip) =>
            clip.kind === 'caption'
              ? {
                  ...clip,
                  label: captionLabel(translationOf(shown.values, clip.variable) ?? clip.text),
                }
              : clip,
          ),
    links: new Map(clips.flatMap((clip) => (clip.link === null ? [] : [[clip.id, clip.link]]))),
    durationMs: latestEnd(main, scene),
    captionsProblem: captionsProblem(
      present.get(project.captionsPath) ?? null,
      captionsHostOf(main)?.attributes,
    ),
    locale: shown,
    locales: [...tables.keys()],
    bindings: new Map(
      clips.flatMap((clip) => {
        const bindings = clip.kind === 'host' ? bindingsOf(main, clip.id) : {}
        return Object.keys(bindings).length === 0 ? [] : [[clip.id, bindings]]
      }),
    ),
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
  }
  return { view, present }
}

/** 工作区里存着的各文件（路径相对工程根 → 文件，不存在的是 null）：主文件、字幕场景和各语言值表。 */
const storedFilesOf = (stored: StoredProject | null): Map<string, StoredFile | null> =>
  new Map<string, StoredFile | null>(
    stored === null
      ? []
      : [
          [PROJECT_MAIN, stored.main],
          [stored.captionsPath, stored.captions],
          ...[...stored.locales].map(([code, file]) => [localePath(code), file] as const),
        ],
  )

const newClipId = () => `clip-${crypto.randomUUID().slice(0, 8)}`

const LINK = 'data-link'

/**
 * 新的链接名（也用作分离出来的原声的出处）：照引擎的取法，不和文件里任何元素的编号、链接名、出处重名。
 */
const newLinkName = (engine: Composition) =>
  mintLinkId(
    engine
      .getElements()
      .flatMap((element) => [
        element.id,
        element.attributes['id'] ?? '',
        element.attributes[LINK] ?? '',
        element.attributes['data-sync-origin'] ?? '',
      ]),
  )

/** 编辑器按算好的样子写一个片段的起止或行：联动的伙伴由调用方一起算进去，不让引擎再带着挪一次。 */
const setOwnTiming = (
  engine: Composition,
  id: string,
  timing: { start?: number; duration?: number; trackIndex?: number },
) => engine.setTiming(id, timing, { linked: false })

/**
 * 做完 `change`（里面用 `setOwnTiming` 写时间）以后，把做之前根下各元素的链接名原样写回去：
 * 引擎只改一个片段时会解除它和伙伴的链接，联动不该因为挪了、裁了就断掉。
 */
const keepingLinks = (engine: Composition, change: () => void) => {
  const before = (rootOf(engine)?.children ?? []).flatMap((element) => {
    const link = element.attributes[LINK]
    return link === undefined ? [] : [[element.id, link] as const]
  })
  change()
  for (const [id, link] of before) {
    const element = engine.getElement(id)
    if (element !== null && element.attributes[LINK] !== link) engine.setAttribute(id, LINK, link)
  }
}

const HF_ID = 'data-hf-id'

/**
 * 要加进根下的一个后半段：它的编号，切的是哪个片段（`of`），写在根下第几个，元素的整段 HTML；`variables` 是
 * 随语言的字段换成的新根变量（原来的 → 新的），要照原来的声明、各语言的值复制一份。
 */
type SplitHalf = {
  id: string
  of: string
  index: number
  html: string
  variables: readonly (readonly [from: string, to: string])[]
}

const SPLIT_FAILED_TEXT = '片段里带有无法复制的内容，无法切开'

/** 有一个后半段没能原样加进去（引擎不收这段 HTML）：整次切开退回去。 */
class HalfRejected extends Error {}

/** 字幕跟着视频片段挪了会和别的字幕重叠：整步编辑退回去。 */
class CaptionsBlocked extends Error {}

/** 删掉一句字幕：场景里它的元素、主文件根上它的变量，和各语言值表里它的值。 */
const removeCaption = (
  main: Composition,
  scene: Composition,
  tables: Iterable<ValueTable>,
  caption: Pick<CaptionClip, 'id' | 'variable'>,
) => {
  scene.removeElement(caption.id)
  if (declares(main, caption.variable)) main.removeVariableDeclaration(caption.variable)
  for (const table of tables) table.set(caption.variable, null)
}

/**
 * 一步编辑做完以后，属于视频片段的字幕跟着它走（规则见 `captionsFollowing`，`before` 是这一步之前的片段）：
 * 挪字幕的起点、删掉没了的视频片段的字幕（见 `removeCaption`）。会重叠时抛出 `CaptionsBlocked`。
 */
const followVideos = (
  main: Composition,
  scene: Composition,
  tables: Iterable<ValueTable>,
  before: readonly FilmClip[],
  catalog: ComponentCatalog,
) => {
  const plan = captionsFollowing(before, allClipsOf(main, scene, catalog))
  if ('refusal' in plan) throw new CaptionsBlocked()
  const captions = captionsById(main, scene)
  for (const [id, start] of plan.starts) setOwnTiming(scene, id, { start: start / 1000 })
  for (const id of plan.removed) {
    const caption = captions.get(id)
    if (caption !== undefined) removeCaption(main, scene, tables, caption)
  }
}

/**
 * 切开以后的各个后半段：在当前主文件的一份副本里把原元素整个复制一份（属性、样式、子元素都带上），
 * 换上新的编号、后半段的起止和入点，紧跟在原元素后面；链接名照引擎的规则重新取，随语言的字段换成按新编号取的
 * 根变量，不和前半段共用。按在根下的先后排，依次加进去时前面加的不会挪动后面要加的位置。找不到根或片段时是 null。
 */
function splitHalves(
  engine: Composition,
  cuts: readonly Cut[],
  clips: readonly FilmClip[],
): readonly SplitHalf[] | null {
  const rootId = rootOf(engine)?.id
  const copy = new DOMParser().parseFromString(engine.serialize(), 'text/html')
  const root = [...copy.querySelectorAll(`[${HF_ID}]`)].find(
    (element) => element.getAttribute(HF_ID) === rootId,
  )
  if (root === undefined) return null
  const kinds = new Map(clips.map((clip) => [clip.id, clip.kind]))
  const halves: { element: Element; of: string; variables: [string, string][] }[] = []
  for (const cut of cuts) {
    const original = [...root.children].find((child) => child.getAttribute(HF_ID) === cut.id)
    if (original === undefined) return null
    const half = original.cloneNode(true) as Element
    const id = newClipId()
    half.id = id
    half.setAttribute(HF_ID, id)
    // 子元素的编号交给引擎重新取，免得和原元素里的重复
    for (const child of half.querySelectorAll(`[${HF_ID}]`)) child.removeAttribute(HF_ID)
    writeClipTiming(half, { start: cut.second.start / 1000, duration: cut.second.duration / 1000 })
    const inPoint = String(cut.second.mediaStart / 1000)
    if (kinds.get(cut.id) === 'host') half.setAttribute('data-playback-start', inPoint)
    else half.setAttribute('data-media-start', inPoint)
    const bindings = Object.entries(
      localeBindingsOf(half.getAttribute(LOCALE_BINDINGS) ?? undefined),
    ).map(([field, from]) => [field, from, localeVariableId(id, field)] as const)
    const renamed = localeBindingsAttribute(
      Object.fromEntries(bindings.map(([field, , to]) => [field, to])),
    )
    if (renamed !== null) half.setAttribute(LOCALE_BINDINGS, renamed)
    original.after(half)
    halves.push({
      element: half,
      of: cut.id,
      variables: bindings.map(([, from, to]) => [from, to]),
    })
  }
  relinkSplitHalves(
    copy,
    halves.map((half) => half.element.id),
  )
  return halves
    .map(({ element, of, variables }) => ({
      id: element.id,
      of,
      index: [...root.children].indexOf(element),
      html: element.outerHTML,
      variables,
    }))
    .toSorted((left, right) => left.index - right.index)
}

type Options = {
  debounceMs?: number
  onNotice: (message: string) => void
}

/**
 * 编辑对话工作区里的 final-cut 工程：打开读到的主文件 `final-cut/index.html`、它的字幕场景文件和各语言的值表
 * （有时；`initial` 见 `readProject`，是 null 时还没有工程），改动停下 `debounceMs` 毫秒后把改了的文件整份保存
 * （主文件第一次新建、之后按版本号写；别的文件先存，主文件最后存）。打开着的文件有一个在别处被改了、或保存时
 * 版本对不上，就都换上工作区里的那一份、放弃本地没存的改动；工程里主文件和值表以外的文件变了时 `filesRevision`
 * 加 1，预览据此重新加载。当前显示的语言打开时是中文。
 */
export function useFilmSession(
  conversationId: string,
  initial: StoredProject | null,
  catalog: ComponentCatalog,
  { debounceMs = 800, onNotice }: Options,
) {
  const [film, setFilm] = useState<FilmView | null>(null)
  const [opening, setOpening] = useState(initial !== null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [filesRevision, setFilesRevision] = useState(0)
  const projectRef = useRef<Project | null>(null)
  const [history] = useState(createUndoHistory)
  // 正在做的编辑动作里引擎报的改动，做完记成一步撤销
  const stepRef = useRef<PatchChange[] | null>(null)
  const creatingRef = useRef<Promise<Project> | null>(null)
  const creatingCaptionsRef = useRef<Promise<Composition | undefined> | null>(null)
  // 正在加的语言：建好值表文件、放进工程之前，检查别处的改动要等它
  const addingLocaleRef = useRef<Promise<void> | null>(null)
  // 当前显示的语言：编辑器自己的状态，不存进文件
  const localeRef = useRef<LocaleCode>(SOURCE_LOCALE)
  // 各文件现在的内容（路径 → 内容），和 `saved` 不一样的就是没存的
  const presentRef = useRef<ReadonlyMap<string, string>>(new Map())
  const inFlightRef = useRef<Promise<void> | null>(null)
  const noticeRef = useRef(onNotice)
  useLayoutEffect(() => {
    noticeRef.current = onNotice
  })

  /** 改动都从这里发出，改完读一遍现在的样子。 */
  const show = useCallback(() => {
    const project = projectRef.current
    const shown = project === null ? null : viewOf(project, catalog, history, localeRef.current)
    presentRef.current = shown?.present ?? new Map()
    setFilm(shown?.view ?? null)
  }, [catalog, history])

  const collect = useCallback((change: PatchChange) => {
    stepRef.current?.push(change)
  }, [])

  /**
   * 编辑动作都从这里改工程：`change` 和工程总长在一批操作里做完（每个打开着的文件各一批，里面抛出时都退回），
   * 引擎报的改动不管改了几个文件都记成一步撤销。
   */
  const perform = useCallback(
    (project: Project, change: () => void) => {
      const main = mainOf(project)
      const others = [...project.files]
        .filter(([path]) => path !== PROJECT_MAIN)
        .map(([, file]) => docOps(file.doc))
      const step: PatchChange[] = []
      stepRef.current = step
      try {
        main.batch(() => {
          others.reduce<() => void>((inner, doc) => () => doc.batch(inner), change)()
          writeTotal(main, sceneOf(project))
        })
      } finally {
        stepRef.current = null
      }
      history.record(step)
    },
    [history],
  )

  /**
   * 换上一份工程（null 是还没有工程），撤销记录清空；`stored` 为真时各文件现在的内容就是工作区里存着的那一份。
   * 当前语言的值表不在新的工程里时回到中文。
   */
  const install = useCallback(
    (project: Project | null, stored: boolean) => {
      disposeAll(projectRef.current)
      history.clear()
      projectRef.current = project
      if (project === null || !tablesOf(project).has(localeRef.current))
        localeRef.current = SOURCE_LOCALE
      show()
      if (stored && project !== null)
        for (const [path, file] of project.files) file.saved = presentRef.current.get(path) ?? null
    },
    [history, show],
  )

  /**
   * 打开工作区里存着的工程 `stored`（null 是还没有工程，见 `readProject`）：主文件、字幕场景文件和各语言的值表。
   * 有字幕宿主但场景文件不存在时按没有字幕打开，提示一句。
   */
  const openStored = useCallback(
    async (stored: StoredProject | null): Promise<Project | null> => {
      if (stored === null) return null
      if (stored.captions === null && stored.hosted) noticeRef.current(CAPTIONS_MISSING_TEXT)
      const files = new Map<string, OpenFile>()
      for (const [path, file] of storedFilesOf(stored))
        if (file !== null)
          files.set(path, {
            doc: await openDoc(path, file.content, collect),
            version: file.version,
            saved: null,
          })
      return { files, captionsPath: stored.captionsPath }
    },
    [collect],
  )

  const [initialProject] = useState(initial)
  useEffect(() => {
    if (initialProject === null) return
    let cancelled = false
    void openStored(initialProject).then((project) => {
      if (cancelled) {
        disposeAll(project)
        return
      }
      install(project, true)
      setOpening(false)
    })
    return () => {
      cancelled = true
    }
  }, [initialProject, install, openStored])

  /** 在途的保存和正在加的语言都结束。 */
  const settled = useCallback(async () => {
    while (inFlightRef.current !== null || addingLocaleRef.current !== null)
      await (inFlightRef.current ?? addingLocaleRef.current)
  }, [])

  /** 换上工作区里现在的那一份 `stored`，放弃本地没存的改动并提示。 */
  const adoptStored = useCallback(
    async (stored: StoredProject | null) => {
      install(await openStored(stored), true)
      noticeRef.current(STALE_NOTICE)
    },
    [install, openStored],
  )

  const saveNow = useCallback(async (): Promise<'saved' | 'clean' | 'reloaded' | 'failed'> => {
    await settled()
    const present = presentRef.current
    // 字幕场景先存、主文件后存：主文件挂载着场景，先存主文件的话预览可能取到还没存的场景
    const writes = [...(projectRef.current?.files ?? [])]
      .flatMap(([path, file]) => {
        const content = present.get(path)
        return content === undefined || content === file.saved ? [] : [{ path, file, content }]
      })
      .toSorted(
        (left, right) => Number(left.path === PROJECT_MAIN) - Number(right.path === PROJECT_MAIN),
      )
    if (writes.length === 0) return 'clean'
    const run = (async () => {
      setSave({ kind: 'saving' })
      try {
        for (const { path, file, content } of writes) {
          file.version =
            file.version === null
              ? await createProjectFile(conversationId, path, content)
              : await writeProjectFile(conversationId, path, content, file.version)
          file.saved = content
        }
        setSave({ kind: 'idle' })
        return 'saved' as const
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          try {
            await adoptStored(await readProject(conversationId))
            setSave({ kind: 'idle' })
            return 'reloaded' as const
          } catch (reloadError) {
            setSave({ kind: 'failed', message: errorMessageOf(reloadError, 'final-cut 读取失败') })
            return 'failed' as const
          }
        }
        setSave({ kind: 'failed', message: errorMessageOf(error, 'final-cut 保存失败') })
        return 'failed' as const
      }
    })()
    inFlightRef.current = run.then(() => undefined)
    try {
      return await run
    } finally {
      inFlightRef.current = null
    }
  }, [adoptStored, conversationId, settled])

  /**
   * 打开着的文件（没有工程时是主文件）或语言值表变了：通知不带版本号，自己的保存也会通知。等在途的保存结束再读，
   * 读回来以后再等一次（读的时候可能又存了一版），有一个文件在工作区里的版本比自己知道的新（或文件出现、
   * 消失了，含别处加的语言）才算别处改的。
   */
  const checkStored = useCallback(async () => {
    try {
      await settled()
      const stored = await readProject(conversationId)
      await settled()
      const storedFiles = storedFilesOf(stored)
      const files = projectRef.current?.files
      const paths = new Set([
        ...(files?.keys() ?? [PROJECT_MAIN]),
        ...[...storedFiles.keys()].filter((path) => localeOfPath(path) !== undefined),
      ])
      const external = [...paths].some((path) => {
        const found = storedFiles.get(path) ?? null
        const known = files?.get(path)?.version ?? null
        return found === null ? known !== null : known === null || found.version > known
      })
      if (external) await adoptStored(stored)
    } catch (error) {
      setSave({ kind: 'failed', message: errorMessageOf(error, 'final-cut 读取失败') })
    }
  }, [adoptStored, conversationId, settled])

  const connection = use(TranscriptConnectionContext)
  useEffect(() => {
    if (connection === null) return undefined
    const unwatchFiles = connection.watchFs(
      conversationId,
      [PROJECT_DIR],
      (changes) => {
        const opened = [...(projectRef.current?.files.keys() ?? [PROJECT_MAIN])]
        const watched = new Set(opened.map((path) => `${PROJECT_DIR}/${path}`))
        if (
          changes.some(
            (change) => watched.has(change.path) || projectLocaleOf(change.path) !== undefined,
          )
        )
          void checkStored()
        // 字幕场景存好以后也要让预览重新加载：预览从工作区取它。值表预览不取，语言的值随主文件一起发过去
        if (
          changes.some(
            (change) =>
              change.path !== PROJECT_MAIN_PATH && projectLocaleOf(change.path) === undefined,
          )
        )
          setFilesRevision((revision) => revision + 1)
      },
      { recursive: true },
    )
    // 断线期间的通知收不到：重连后按打开着的文件变了、别的文件也变了处理
    const unwatchSessions = connection.watchSessions((update) => {
      if (update.kind !== 'reconnected') return
      void checkStored()
      setFilesRevision((revision) => revision + 1)
    })
    return () => {
      unwatchFiles()
      unwatchSessions()
    }
  }, [checkStored, connection, conversationId])

  useEffect(() => {
    if (film === null || !unsaved(projectRef.current, presentRef.current)) return
    const timer = setTimeout(() => void saveNow(), debounceMs)
    return () => clearTimeout(timer)
  }, [film, debounceMs, saveNow])

  // 卸载时把没存的存掉；连同还在途的那次一起交给主文件的读取，再打开时等它们存完再读
  useEffect(
    () => () => {
      if (unsaved(projectRef.current, presentRef.current) || inFlightRef.current !== null)
        holdProjectReads(conversationId, saveNow())
    },
    [conversationId, saveNow],
  )

  useEffect(() => () => disposeAll(projectRef.current), [])

  /** 还没有工程时按 `canvas` 用模板建一份；连着加两次也只建一份，后一次等前一次建好。 */
  const projectFor = useCallback(
    async (canvas: Canvas): Promise<Project> => {
      if (projectRef.current !== null) return projectRef.current
      creatingRef.current ??= openDoc(PROJECT_MAIN, emptyProject(canvas, catalog), collect)
        .then((doc) => {
          const project: Project = {
            files: new Map([[PROJECT_MAIN, { doc, version: null, saved: null }]]),
            captionsPath: CAPTIONS_PATH,
          }
          install(project, false)
          return project
        })
        .finally(() => {
          creatingRef.current = null
        })
      return creatingRef.current
    },
    [catalog, collect, install],
  )

  /**
   * 把几段素材一段接一段放进画面区：给了 `at` 就从那一行的那个时间放起（调用方保证那里空着），
   * 没给就接在主轨（画面区最上面那一行）的末尾。`renumber` 是为它新开一行时别的片段要换成的行号。
   * 每段都叠在最上面，写在根下第一个。还没有工程时先按 `canvas` 建一份。放不下时不动工程。
   */
  const addVideos = useCallback(
    async (
      canvas: Canvas,
      videos: readonly NewVideo[],
      at?: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      const project = await projectFor(canvas)
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return false
      const existing = clipsOf(engine, catalog)
      // 别的片段先换成新的行号，后面都按换完的样子算
      const others = existing.map((clip) => ({
        ...clip,
        track: renumber.get(clip.id) ?? clip.track,
      }))
      const track = at?.track ?? topTrack(others)
      const row = others.filter((clip) => onRow(clip, { zone: 'visual', track }))
      let end = at?.start ?? Math.max(0, ...row.map((clip) => clip.start + clip.duration))
      perform(project, () => {
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        for (const [placed, video] of videos.entries()) {
          const element = videoElement({
            ...video,
            id: newClipId(),
            start: end,
            track,
            volume: 1,
            playbackRate: 1,
            fadeIn: 0,
            fadeOut: 0,
            z: newClipZ(existing, placed),
            hidden: false,
            link: null,
            syncOrigin: null,
          })
          engine.addElement(root.id, 0, element)
          end += video.duration
        }
      })
      show()
      return true
    },
    [catalog, projectFor, perform, show],
  )

  /**
   * 把组件库的一个条目放进工程：先把条目的文件拷进工程，再从 `at` 那一行的那个时间放起（调用方保证那里空着），
   * 可填项取 `values`，时长取条目的时长。工程里有外语时，文字字段按默认规则随语言（见 `followingByDefault`）。
   * `renumber` 同 `addVideos`。
   * 叠在最上面，写在根下第一个。还没有工程时先按 `canvas` 建一份。文件拷不进来时提示原因，不动工程。
   */
  const addItem = useCallback(
    async (
      canvas: Canvas,
      item: CatalogItem,
      values: Readonly<Record<string, VariableValue>>,
      at: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      try {
        await copyItemFiles(conversationId, catalog, item)
      } catch (error) {
        noticeRef.current(errorMessageOf(error, '贴片和场景读取失败'))
        return false
      }
      const project = await projectFor(canvas)
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return false
      const existing = clipsOf(engine, catalog)
      const duration = itemDurationMs(item, existing)
      const size = {
        width: Number(root.attributes['data-width'] ?? canvas.width),
        height: Number(root.attributes['data-height'] ?? canvas.height),
      }
      const id = newClipId()
      perform(project, () => {
        for (const [other, next] of renumber) engine.setTiming(other, { trackIndex: next })
        const element = hostElement(
          {
            id,
            label: item.title,
            item: item.name,
            src: item.src,
            start: at.start,
            duration,
            playbackStart: 0,
            track: at.track,
            values: { ...values },
            z: newClipZ(existing, 0),
            hidden: false,
            link: null,
          },
          item,
          size,
          catalog,
        )
        engine.addElement(root.id, 0, element)
        if (tablesOf(project).size > 0)
          for (const field of followingByDefault(engine, { id, values }, item))
            followLocale(engine, { id, values }, field)
      })
      show()
      return true
    },
    [catalog, conversationId, projectFor, perform, show],
  )

  /**
   * 把一段音频放进声音区：从 `at` 那一行的那个时间放起（调用方保证那里空着）。
   * 写在根下第一个，不带叠放顺序。`renumber` 同 `addVideos`。还没有工程时先按 `canvas` 建一份。
   */
  const addAudio = useCallback(
    async (
      canvas: Canvas,
      audio: NewAudio,
      at: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      const project = await projectFor(canvas)
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return false
      perform(project, () => {
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        const element = audioElement({
          ...audio,
          id: newClipId(),
          start: at.start,
          track: at.track,
          volume: 1,
          playbackRate: 1,
          fadeIn: 0,
          fadeOut: 0,
          loop: false,
          hidden: false,
          link: null,
          syncOrigin: null,
        })
        engine.addElement(root.id, 0, element)
      })
      show()
      return true
    },
    [projectFor, perform, show],
  )

  /**
   * 改工程里已有的东西：`change` 拿到主文件、字幕场景（没有时是 undefined）和各语言的值表，里面的几步和工程总长
   * 一起算一步撤销。属于视频片段的字幕在同一步里跟着它走（见 `followVideos`）；跟着挪会和别的字幕重叠时整步
   * 不做，提示原因。
   */
  const edit = useCallback(
    (
      change: (
        main: Composition,
        scene: Composition | undefined,
        tables: ReadonlyMap<LocaleCode, ValueTable>,
      ) => void,
    ) => {
      const project = projectRef.current
      if (project === null) return
      const main = mainOf(project)
      const tables = tablesOf(project)
      try {
        perform(project, () => {
          const scene = sceneOf(project)
          const before = allClipsOf(main, scene, catalog)
          change(main, scene, tables)
          if (scene !== undefined) followVideos(main, scene, tables.values(), before, catalog)
        })
      } catch (error) {
        // 一批操作里抛出时引擎已经整批退回
        if (!(error instanceof CaptionsBlocked)) throw error
        noticeRef.current(CAPTION_FOLLOW_REFUSAL_TEXT)
      }
      show()
    },
    [catalog, perform, show],
  )

  /**
   * 改几个片段各自的起止和入点，一起算一步撤销。组件或块的片段的入点写成从第几秒开始播，是 0 时去掉
   * 这个属性；「其他」片段和字幕没有入点，只改起止（字幕改在字幕场景里）。联动的伙伴要跟着动时由调用方
   * 算进 `timings`。
   */
  const retime = useCallback(
    (timings: ReadonlyMap<string, Timing>) =>
      edit((engine, scene) => {
        const kinds = new Map(clipsOf(engine, catalog).map((clip) => [clip.id, clip.kind]))
        const captions = captionsById(engine, scene)
        keepingLinks(engine, () => {
          for (const [id, timing] of timings) {
            const span = { start: timing.start / 1000, duration: timing.duration / 1000 }
            setOwnTiming(fileOf(engine, scene, captions, id), id, span)
            const kind = kinds.get(id)
            const inPoint = String(timing.mediaStart / 1000)
            if (kind === 'host')
              engine.setAttribute(id, 'data-playback-start', timing.mediaStart > 0 ? inPoint : null)
            else if (kind === 'video' || kind === 'audio')
              engine.setAttribute(id, 'data-media-start', inPoint)
          }
        })
      }),
    [catalog, edit],
  )

  /**
   * 把一个片段换到另一行的某个时间。`direction` 是它往上还是往下挪（null 时不调叠放顺序）：
   * 只重排它自己，别的片段的叠放顺序和文件里的先后都不动。
   * `renumber` 是为它新开一行时别的片段要换成的行号；`starts` 是和它一起挪的片段（含联动的伙伴，字幕改在字幕
   * 场景里）各自的新起点，它们留在原来的行。都和它算一步撤销。
   */
  const moveClip = useCallback(
    (
      id: string,
      at: Landing,
      direction: StackingDirection | null,
      renumber: Renumbering = NO_RENUMBERING,
      starts: ReadonlyMap<string, number> = NO_STARTS,
    ) =>
      edit((engine, scene) => {
        const captions = captionsById(engine, scene)
        for (const [other, next] of renumber) engine.setTiming(other, { trackIndex: next })
        keepingLinks(engine, () => {
          for (const [other, start] of starts)
            setOwnTiming(fileOf(engine, scene, captions, other), other, { start: start / 1000 })
          setOwnTiming(engine, id, { start: at.start / 1000, trackIndex: at.track })
        })
        if (direction === null) return
        // 按挪完的样子算：一起挪的片段的新起点、别的片段的新行号都已写进去
        const z = restackedZ(clipsOf(engine, catalog), id, direction)
        if (z !== undefined) engine.setStyle(id, { zIndex: z > 0 ? String(z) : null })
      }),
    [catalog, edit],
  )

  /** 把几个片段各自挪到新的起点（合拢空档），联动的伙伴挪同样的时间差，一起算一步撤销。 */
  const restart = useCallback(
    (starts: ReadonlyMap<string, number>) =>
      edit((engine) => {
        const all = withLinkedStarts(starts, clipsOf(engine, catalog))
        keepingLinks(engine, () => {
          for (const [id, start] of all) setOwnTiming(engine, id, { start: start / 1000 })
        })
      }),
    [catalog, edit],
  )

  /**
   * 把几个片段一起隐藏或显示回来，算一步撤销。字幕不能单句隐藏：给到字幕时隐藏、显示的是主文件里的字幕宿主，
   * 所有字幕一起。
   */
  const setHidden = useCallback(
    (ids: readonly string[], hidden: boolean) =>
      edit((engine, scene) => {
        const captions = captionsById(engine, scene)
        const host = captionsHostOf(engine)?.id
        const targets = new Set(ids.map((id) => (captions.has(id) ? host : id)))
        for (const id of targets)
          if (id !== undefined) engine.setAttribute(id, 'data-hidden', hidden ? '' : null)
      }),
    [edit],
  )

  /** 组件或块的片段 `id`；不在工程里时是 undefined。 */
  const hostClip = useCallback(
    (id: string): HostClip | undefined => {
      const project = projectRef.current
      const clip =
        project === null ? undefined : clipsOf(mainOf(project), catalog).find((c) => c.id === id)
      return clip?.kind === 'host' ? clip : undefined
    },
    [catalog],
  )

  /**
   * 把组件或块的片段 `id` 的可填项取值整个换成 `values`（中文），宿主上的字体变量跟着重算，随语言的字段的根变量
   * 默认值跟着改成新的字，算一步撤销。片段已经不在工程里（比如改完还没提交就删掉了）时不动工程。
   */
  const setValues = useCallback(
    (id: string, values: Readonly<Record<string, VariableValue>>) => {
      const clip = hostClip(id)
      if (clip === undefined) return
      const item = itemNamed(catalog, clip.item)
      edit((current) => {
        current.setAttribute(id, 'data-variable-values', JSON.stringify(values))
        if (item !== undefined) current.setStyle(id, itemFonts(item, values, catalog))
        for (const [fieldId, variable] of Object.entries(bindingsOf(current, id))) {
          const field = item?.variables.find((candidate) => candidate.id === fieldId)
          if (field !== undefined)
            writeDefault(current, variable, field.label, fieldText(values, field))
        }
      })
    },
    [catalog, edit, hostClip],
  )

  /**
   * 把片段 `id` 的文字字段 `fieldId` 在语言 `locale` 里的字改成 `text`，算一步撤销。中文改的是宿主的取值
   * （见 `setValues`）；外语下随语言的字段改的是那种语言值表里它的根变量的值（`text` 是空的时去掉，回到用中文），
   * 固定的字段不改。字没变、片段不在了时不动工程。
   */
  const setItemText = useCallback(
    (id: string, fieldId: string, text: string, locale: LocaleCode) => {
      const project = projectRef.current
      const clip = hostClip(id)
      const field = itemNamed(catalog, clip?.item ?? '')?.variables.find((v) => v.id === fieldId)
      if (project === null || clip === undefined || field === undefined) return
      if (locale === SOURCE_LOCALE) {
        if (fieldText(clip.values, field) !== text)
          setValues(id, { ...clip.values, [fieldId]: text })
        return
      }
      const variable = bindingsOf(mainOf(project), id)[fieldId]
      const table = tablesOf(project).get(locale)
      const value = text === '' ? null : text
      if (variable === undefined || table === undefined) return
      if (translationOf(table.values(), variable) === value) return
      edit(() => table.set(variable, value))
    },
    [catalog, edit, hostClip, setValues],
  )

  /**
   * 片段 `id` 的文字字段 `fieldId` 改成随语言（`follow`，见 `followLocale`）或固定（见 `pinField`），算一步撤销。
   * 已经是这样、片段不在了时不动工程。
   */
  const setFollowsLocale = useCallback(
    (id: string, fieldId: string, follow: boolean) => {
      const project = projectRef.current
      const clip = hostClip(id)
      const field = itemNamed(catalog, clip?.item ?? '')?.variables.find((v) => v.id === fieldId)
      if (project === null || clip === undefined || field === undefined) return
      if ((bindingsOf(mainOf(project), id)[fieldId] !== undefined) === follow) return
      edit((main, _scene, tables) => {
        if (follow) followLocale(main, clip, field)
        else pinField(main, tables.values(), id, fieldId)
      })
    },
    [catalog, edit, hostClip],
  )

  /**
   * 在几个片段上都改同样的几个属性（null 是去掉），算一步撤销。不在工程里的片段跳过；
   * 属性都已经是这些值时不动工程。
   */
  const setAttributes = useCallback(
    (ids: readonly string[], changes: Readonly<Partial<Record<ClipAttribute, string | null>>>) => {
      const project = projectRef.current
      if (project === null) return
      const engine = mainOf(project)
      const changed = ids.flatMap((id) => {
        const element = engine.getElement(id)
        if (element === null) return []
        return Object.entries(changes)
          .filter(([name, value]) => (element.attributes[name] ?? null) !== value)
          .map(([name, value]) => ({ id, name, value: value ?? null }))
      })
      if (changed.length === 0) return
      edit((current) => {
        for (const { id, name, value } of changed) current.setAttribute(id, name, value)
      })
    },
    [edit],
  )

  /**
   * 删掉几个片段；`ripple` 为真时主轨里后面的片段往前补上，联动的伙伴挪同样的时间差。删一句字幕是删掉
   * 场景里它的元素、主文件根上它的变量和各语言值表里它的值；删掉最后一句时场景文件和宿主都留着。
   * 删组件或块的片段时它随语言的字段的根变量和各语言值表里的值一起删掉。
   */
  const removeClips = useCallback(
    (ids: readonly string[], ripple: boolean) =>
      edit((engine, scene, tables) => {
        const before = clipsOf(engine, catalog)
        const captions = captionsById(engine, scene)
        const gone = new Set(ids)
        const starts = ripple ? withLinkedStarts(rippleStarts(before, gone), before) : NO_STARTS
        for (const id of gone) {
          const caption = captions.get(id)
          if (scene !== undefined && caption !== undefined) {
            removeCaption(engine, scene, tables.values(), caption)
            continue
          }
          for (const fieldId of Object.keys(bindingsOf(engine, id)))
            pinField(engine, tables.values(), id, fieldId)
          engine.removeElement(id)
        }
        keepingLinks(engine, () => {
          for (const [id, start] of starts)
            if (!gone.has(id)) setOwnTiming(engine, id, { start: start / 1000 })
        })
      }),
    [catalog, edit],
  )

  /**
   * 把视频片段 `videoId` 的原声分离成一个音频片段，算一步撤销：视频片段关掉原声、声音属性搬走，原声片段
   * 和它同一个地址、同样的起止、入点、速度，写在文件里紧挨着它前面，放进「人声」行（见 `voiceRowFor`）；
   * 两段写上同一个新的链接名，也当出处，联动着。返回原声片段的编号；片段不是视频片段时不动工程。
   */
  const detach = useCallback(
    (videoId: string): string | undefined => {
      const project = projectRef.current
      const engine = project === null ? undefined : mainOf(project)
      const root = engine === undefined ? undefined : rootOf(engine)
      if (engine === undefined || root === undefined) return undefined
      const clips = clipsOf(engine, catalog)
      const video = clips.find((clip) => clip.id === videoId)
      if (video?.kind !== 'video') return undefined
      const name = newLinkName(engine)
      const { track, renumber } = voiceRowFor(clips, video.start, video.duration)
      const index = root.children.findIndex((child) => child.id === videoId)
      let added: string | undefined
      edit((current) => {
        for (const [id, next] of renumber) current.setTiming(id, { trackIndex: next })
        added = current.addElement(
          root.id,
          index,
          audioElement({
            id: newClipId(),
            label: `${video.label} · 原声`,
            src: video.src,
            start: video.start,
            duration: video.duration,
            mediaStart: video.mediaStart,
            playbackRate: video.playbackRate,
            volume: video.volume,
            fadeIn: video.fadeIn,
            fadeOut: video.fadeOut,
            track,
            loop: false,
            hidden: video.hidden,
            link: name,
            syncOrigin: name,
          }),
        )
        for (const [attribute, value] of Object.entries(detachedVideoChanges(name)))
          current.setAttribute(videoId, attribute, value ?? null)
      })
      return added
    },
    [catalog, edit],
  )

  /**
   * 把分离出来的原声合并回视频片段，算一步撤销：原声上的声音属性写回视频片段，视频片段打开原声、去掉链接名
   * 和出处，原声片段删掉。能不能合并由调用方按 `mergeBlocked` 先查。
   */
  const merge = useCallback(
    ({ video, audio }: SoundPair) => {
      const project = projectRef.current
      const element = project === null ? null : mainOf(project).getElement(audio.id)
      if (element === null) return
      const changes: AttributeChanges = mergedVideoChanges(element.attributes)
      edit((current) => {
        for (const [attribute, value] of Object.entries(changes))
          current.setAttribute(video.id, attribute, value ?? null)
        current.removeElement(audio.id)
      })
    },
    [edit],
  )

  /** 打开（两段写上一个新的链接名）或关掉（两段去掉链接名）一对的联动，算一步撤销。 */
  const setLinked = useCallback(
    ({ video, audio }: SoundPair, linked: boolean) =>
      edit((engine) => {
        const name = linked ? newLinkName(engine) : null
        for (const id of [video.id, audio.id]) engine.setAttribute(id, LINK, name)
      }),
    [edit],
  )

  /** 对齐口型：只把原声片段 `audioId` 挪到 `startMs`（由 `resyncPlan` 算好），联动不变，算一步撤销。 */
  const resync = useCallback(
    (audioId: string, startMs: number) =>
      edit((engine) =>
        keepingLinks(engine, () => setOwnTiming(engine, audioId, { start: startMs / 1000 })),
      ),
    [edit],
  )

  /**
   * 切开几个片段（`cuts` 由 `clip-edit.ts` 里的切开函数算好），算一步撤销：前半段还是原来的片段、只改时长，
   * 后半段是它的整份复制、紧跟在它后面，随语言的字段的根变量连同各语言的值复制一份给它；切的是视频片段时，
   * 从切点起的字幕改成属于后半段（见 `splitOwners`）。
   * 有一个后半段写不进去（比如元素里带着脚本）时都不切，提示原因。
   */
  const split = useCallback(
    (cuts: readonly Cut[]) => {
      const project = projectRef.current
      if (project === null || cuts.length === 0) return
      const engine = mainOf(project)
      const root = rootOf(engine)
      if (root === undefined) return
      const halves = splitHalves(engine, cuts, clipsOf(engine, catalog))
      if (halves === null) return
      const owners = splitOwners(
        allClipsOf(engine, sceneOf(project), catalog),
        cuts,
        new Map(halves.map((half) => [half.of, half.id])),
      )
      try {
        edit((current, scene, tables) => {
          for (const half of halves)
            if (current.addElement(root.id, half.index, half.html) !== half.id)
              throw new HalfRejected()
          for (const [from, to] of halves.flatMap((half) => half.variables)) {
            const declaration = current.getVariableDeclarations().find((each) => each.id === from)
            if (declaration !== undefined) current.declareVariable({ ...declaration, id: to })
            for (const table of tables.values()) {
              const value = translationOf(table.values(), from)
              if (value !== null) table.set(to, value)
            }
          }
          // 链接的片段切在同一处：SDK 把时长带给结尾对齐的链接片段时，带过去的也正好是切点
          for (const cut of cuts) current.setTiming(cut.id, { duration: cut.first.duration / 1000 })
          for (const [id, owner] of owners) scene?.setAttribute(id, CAPTION_OWNER, owner)
        })
      } catch (error) {
        // 一批操作里抛出时引擎已经整批退回
        if (!(error instanceof HalfRejected)) throw error
        noticeRef.current(SPLIT_FAILED_TEXT)
      }
    },
    [catalog, edit],
  )

  /**
   * 工程里的字幕场景文件，还没有时先在工作区里建一份空的（不进撤销）；建的时候已经有了（409，比如加了又撤销
   * 留下的空文件）就用工作区里的那一份。连着加两句也只建一次。工程在这期间换过了时答复 undefined。
   */
  const captionsFile = useCallback(
    async (project: Project): Promise<Composition | undefined> => {
      const opened = sceneOf(project)
      if (opened !== undefined) return opened
      creatingCaptionsRef.current ??= (async () => {
        const path = project.captionsPath
        const content = captionsScene(canvasOf(mainOf(project)), catalog)
        let stored: StoredFile | null
        try {
          stored = { content, version: await createProjectFile(conversationId, path, content) }
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          stored = await readProjectFile(conversationId, path)
          if (stored === null) throw error
        }
        const engine = await openEngine(stored.content, path, collect)
        if (projectRef.current !== project) {
          engine.dispose()
          return undefined
        }
        // 打开后 SDK 存出的样子当作已存的那一份，不然一打开就算有改动
        const doc: FileDoc = { kind: 'composition', engine }
        project.files.set(path, { doc, version: stored.version, saved: engine.serialize() })
        return engine
      })().finally(() => {
        creatingCaptionsRef.current = null
      })
      return creatingCaptionsRef.current
    },
    [catalog, collect, conversationId],
  )

  /**
   * 加几句字幕，一起算一步撤销：先准备好字幕场景文件（还没有时建一份空的），再按那时工程里的片段（含字幕）
   * 用 `captionsFor` 算出要加的句子，场景里各按开始时间排进它的元素，主文件根上各声明一个变量；主文件里还没有
   * 字幕宿主时加在根下最后。答复新字幕的编号（按 `captionsFor` 给的先后；一句都没有时是空的、不动工程）；
   * 还没有工程、场景文件建不了时不动工程（建不了时提示原因），答复 undefined。
   */
  const addCaptions = useCallback(
    async (
      captionsFor: (clips: readonly FilmClip[]) => readonly NewCaption[],
    ): Promise<string[] | undefined> => {
      const project = projectRef.current
      if (project === null) return undefined
      let scene: Composition | undefined
      try {
        scene = await captionsFile(project)
      } catch (error) {
        noticeRef.current(errorMessageOf(error, '字幕文件新建失败，请重试'))
        return undefined
      }
      const main = mainOf(project)
      const root = rootOf(main)
      const sceneRoot = scene === undefined ? undefined : rootOf(scene)
      if (scene === undefined || root === undefined || sceneRoot === undefined) return undefined
      const captions = captionsFor(allClipsOf(main, scene, catalog)).map((caption) => {
        const key = crypto.randomUUID().slice(0, 8)
        return { ...caption, id: `cap-${key}`, variable: `cap_${key}` }
      })
      if (captions.length === 0) return []
      perform(project, () => {
        if (captionsHostOf(main) === undefined)
          main.addElement(root.id, root.children.length, captionsHostElement(canvasOf(main), 0))
        for (const caption of captions) {
          // 按加过前面几句的样子找位置
          const timings = scene.getElementTimings()
          const children = rootOf(scene)?.children ?? []
          const later = children.findIndex(
            (child) => (timings[child.id]?.enterAt ?? -Infinity) * 1000 > caption.start,
          )
          scene.addElement(
            sceneRoot.id,
            later === -1 ? children.length : later,
            captionElement(caption),
          )
          main.declareVariable(captionVariable(caption))
        }
      })
      show()
      return captions.map((caption) => caption.id)
    },
    [captionsFile, catalog, perform, show],
  )

  /**
   * 把字幕 `id` 在语言 `locale` 里的字改成 `text`，算一步撤销。中文改的是原文：主文件根上它的变量的默认值改成它
   * （还没声明时声明上），场景里那个元素的字也改成一样的。外语改的是那种语言的值表里这个变量的值，`text` 是
   * 空的时从值表里去掉（回到用原文），原文不动。字没变、字幕已经不在了、没有这种语言时不动工程。
   */
  const setCaptionText = useCallback(
    (id: string, text: string, locale: LocaleCode) => {
      const project = projectRef.current
      const scene = project === null ? undefined : sceneOf(project)
      const caption = project === null ? undefined : captionsById(mainOf(project), scene).get(id)
      if (project === null || scene === undefined || caption === undefined) return
      if (locale !== SOURCE_LOCALE) {
        const table = tablesOf(project).get(locale)
        const value = text === '' ? null : text
        if (table === undefined || caption.variable === '') return
        if (translationOf(table.values(), caption.variable) === value) return
        edit(() => table.set(caption.variable, value))
        return
      }
      if (caption.text === text) return
      edit((main) => {
        if (caption.variable !== '') {
          if (declares(main, caption.variable)) main.setVariableValue(caption.variable, text)
          else main.declareVariable(captionVariable({ variable: caption.variable, text }))
        }
        scene.setText(id, text)
      })
    },
    [edit],
  )

  /** 切换显示的语言（不进撤销、不改文件）；工程里没有这种语言的值表时不切。 */
  const setLocale = useCallback(
    (locale: LocaleCode) => {
      const project = projectRef.current
      if (project === null || (locale !== SOURCE_LOCALE && !tablesOf(project).has(locale))) return
      localeRef.current = locale
      show()
    },
    [show],
  )

  /**
   * 加一种语言并切过去：在工作区里建一份空的值表（不进撤销）；建的时候已经有了（409）就用工作区里的那一份。
   * 这是工程里的第一种外语时，接着把所有组件或块的片段的文字字段按默认规则改成随语言（见 `followingByDefault`），
   * 这一步单独算一步撤销（撤销后值表还在，字段都是固定的）。工程里已经有这种语言时直接切过去。建不了时提示原因，
   * 不切。
   */
  const addLocale = useCallback(
    async (locale: LocaleCode) => {
      const project = projectRef.current
      if (project === null || locale === SOURCE_LOCALE) return
      const path = localePath(locale)
      if (!project.files.has(path)) {
        const first = tablesOf(project).size === 0
        const adding = (async () => {
          const content = localeValuesFile({})
          let stored: StoredFile | null
          try {
            stored = { content, version: await createProjectFile(conversationId, path, content) }
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409) throw error
            stored = await readLocaleFile(conversationId, locale)
            if (stored === null) throw error
          }
          const doc = await openDoc(path, stored.content, collect)
          // 工程在这期间换过了（比如别处改了）：换上来的那一份里有没有这种语言由它自己说了算
          if (projectRef.current !== project) return
          project.files.set(path, { doc, version: stored.version, saved: docOps(doc).serialize() })
          if (!first) return
          const main = mainOf(project)
          const following = clipsOf(main, catalog).flatMap((clip) => {
            const item = clip.kind === 'host' ? itemNamed(catalog, clip.item) : undefined
            return clip.kind !== 'host' || item === undefined
              ? []
              : followingByDefault(main, clip, item).map((field) => ({ clip, field }))
          })
          // 一个要改的字段都没有时不记一步（写总长也会报改动）
          if (following.length > 0)
            perform(project, () => {
              for (const { clip, field } of following) followLocale(main, clip, field)
            })
        })()
        addingLocaleRef.current = adding.catch(() => undefined)
        try {
          await adding
        } catch (error) {
          noticeRef.current(errorMessageOf(error, '语言添加失败，请重试'))
          return
        } finally {
          addingLocaleRef.current = null
        }
      }
      setLocale(locale)
    },
    [catalog, collect, conversationId, perform, setLocale],
  )

  const step = (direction: 'undo' | 'redo') => {
    const project = projectRef.current
    const changes = project === null ? undefined : history[direction]()
    if (project === null || changes === undefined) return
    const before = presentRef.current
    try {
      for (const change of changes) {
        const file = project.files.get(change.file)
        if (file === undefined) throw new Error(`撤销记录里的文件没有打开：${change.file}`)
        docOps(file.doc).applyPatches(change.patches)
      }
    } catch (error) {
      console.error('final-cut 撤销重做失败', error)
      noticeRef.current(STEP_FAILED_TEXT[direction])
      // 补丁可能只应用了一半：各文件都换回应用之前的那一份，撤销记录跟着清空
      void restore(project, before)
      return
    }
    show()
  }

  /** 把工程的各文件换成 `contents` 里的内容（路径 → 内容），版本号和已存的那一份不变，撤销记录清空。 */
  const restore = async (project: Project, contents: ReadonlyMap<string, string>) => {
    const files = await Promise.all(
      [...project.files].map(
        async ([path, file]) =>
          [
            path,
            {
              ...file,
              doc: await openDoc(path, contents.get(path) ?? docOps(file.doc).serialize(), collect),
            },
          ] as const,
      ),
    )
    install({ files: new Map(files), captionsPath: project.captionsPath }, false)
  }

  return {
    film,
    opening,
    filesRevision,
    addVideos,
    addItem,
    addAudio,
    retime,
    moveClip,
    restart,
    setHidden,
    setValues,
    setAttributes,
    removeClips,
    split,
    detach,
    merge,
    setLinked,
    resync,
    addCaptions,
    setCaptionText,
    setItemText,
    setFollowsLocale,
    setLocale,
    addLocale,
    undo: () => step('undo'),
    redo: () => step('redo'),
    save,
    flush: () => void saveNow(),
    /** 等没存的改动存完；存好了（或本来就没有要存的）答 true，存失败或换成了别处改的那一份答 false。 */
    settle: async () => {
      const outcome = await saveNow()
      return outcome === 'saved' || outcome === 'clean'
    },
  }
}
