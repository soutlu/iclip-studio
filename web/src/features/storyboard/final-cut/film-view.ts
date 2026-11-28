import type { Composition, ElementSnapshot } from '@hyperframes/sdk'
import { canvasLayersOf, type Mount } from './canvas-layers'
import {
  captionLabel,
  captionOf,
  captionsProblem,
  captionStyleOf,
  isCaptionsHost,
  withCaptionDefaults,
} from './composition/captions'
import type { ComponentCatalog } from './composition/catalog'
import {
  clipOf,
  headBackground,
  PROJECT_MAIN,
  withCanvasSize,
  withFontBlock,
  type Canvas,
  type CaptionClip,
  type FilmClip,
} from './composition/film'
import { LOCALE_BINDINGS, localeBindingsOf, type LocaleBindings } from './composition/locale-text'
import { VOICE_MODES, voiceModeOf, voiceModesOf } from './composition/voices'
import { shownIn } from './dubbing'
import { contentOf, docOps, mainOf, sceneOf, sheetOf, tablesOf, type Project } from './film-files'
import {
  SOURCE_LOCALE,
  SOURCE_SHOWN,
  translationOf,
  type Language,
  type ShownLocale,
} from './locales'
import type { UndoHistory } from './undo-history'
import type { FilmView } from './use-film-session'
import { ownedIn } from './voice-lines'

/** 文件的根：最外层带 `data-composition-id` 的元素（主文件的根、字幕场景的根）。 */
export const rootOf = (engine: Composition): ElementSnapshot | undefined =>
  engine
    .getRootElements()
    .find((element) => element.attributes['data-composition-id'] !== undefined)

/** 主文件里的字幕宿主。 */
export const captionsHostOf = (main: Composition): ElementSnapshot | undefined =>
  rootOf(main)?.children.find((element) => isCaptionsHost(element.attributes))

export const canvasOf = (main: Composition): Canvas => {
  const root = rootOf(main)
  return {
    width: Number(root?.attributes['data-width'] ?? 0),
    height: Number(root?.attributes['data-height'] ?? 0),
  }
}

/**
 * 主文件根下所有带时间的元素（字幕宿主除外）读成的片段，按它们在文件里的先后。不存出文件，一批操作中间也能用。
 */
export const clipsOf = (main: Composition, catalog: ComponentCatalog): FilmClip[] => {
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
export const allClipsOf = (
  main: Composition,
  scene: Composition | undefined,
  catalog: ComponentCatalog,
): FilmClip[] => [
  ...clipsOf(main, catalog),
  ...(scene === undefined ? [] : captionsIn(scene, main)),
]

/** 各句字幕，编号 → 字幕；还没有字幕场景时是空的。 */
export const captionsById = (main: Composition, scene: Composition | undefined) =>
  new Map(
    (scene === undefined ? [] : captionsIn(scene, main)).map((caption) => [caption.id, caption]),
  )

/** 片段 `id` 写在哪个文件里：字幕（`captions` 里的）在字幕场景里，别的在主文件里。 */
export const fileOf = (
  main: Composition,
  scene: Composition | undefined,
  captions: ReadonlyMap<string, CaptionClip>,
  id: string,
): Composition => (scene !== undefined && captions.has(id) ? scene : main)

export const declares = (main: Composition, variable: string) =>
  main.getVariableDeclarations().some((declaration) => declaration.id === variable)

/** 主文件根上的变量现在的默认值；没声明时是 undefined。 */
export const declaredDefault = (main: Composition, variable: string) =>
  main.getVariableDeclarations().find((declaration) => declaration.id === variable)?.default

/** 片段 `id` 上随语言的字段（见 `LOCALE_BINDINGS`）。 */
export const bindingsOf = (main: Composition, id: string): LocaleBindings =>
  localeBindingsOf(main.getElement(id)?.attributes[LOCALE_BINDINGS])

/** 主文件根下挂载着文件的宿主（组件或块的片段、字幕宿主），按文件里的先后。 */
const mountsOf = (main: Composition): Mount[] =>
  (rootOf(main)?.children ?? []).flatMap((element) => {
    const file = element.attributes['data-composition-src']
    return file === undefined
      ? []
      : [{ host: element.id, file, captions: isCaptionsHost(element.attributes) }]
  })

/** 有随语言字段的组件或块的片段各自的字段（见 `FilmView.bindings`）。 */
export const hostBindingsOf = (
  main: Composition,
  clips: readonly FilmClip[],
): Map<string, LocaleBindings> =>
  new Map(
    clips.flatMap((clip) => {
      const bindings = clip.kind === 'host' ? bindingsOf(main, clip.id) : {}
      return Object.keys(bindings).length === 0 ? [] : [[clip.id, bindings] as const]
    }),
  )

/** 工程总长（毫秒）：主文件根下的片段（字幕宿主除外）和各句字幕里最晚的结尾。 */
export const latestEnd = (main: Composition, scene: Composition | undefined): number => {
  const skipped = new Set([rootOf(main)?.id, captionsHostOf(main)?.id])
  const ends = (engine: Composition) =>
    Object.entries(engine.getElementTimings())
      .filter(([id]) => !skipped.has(id))
      .map(([, timing]) => timing.exitAt * 1000)
  if (scene !== undefined) skipped.add(rootOf(scene)?.id)
  return Math.round(Math.max(0, ...ends(main), ...(scene === undefined ? [] : ends(scene))))
}

/**
 * 构造当前工程视图（按展示语言 `locale` 映射显示文本）及各打开文件的最新序列化内容（路径 → 内容）：
 * 主文件额外重算 `<head>` 中的字体块与模板画布尺寸（SDK 不负责改写 `<head>`），其中字体块汇总原文与全部语言值表字符，
 * 确保落盘结果与当前展示语言无关；模板尺寸与字幕场景统一样式默认字号均随根节点画布尺寸重算（见 `withCaptionDefaults`），
 * 撤销根节点变更时自动还原。其余文件直接采用各自序列化结果。`change` 携带本版递增序号与增量步骤（见 `FilmView`）。
 */
export const viewOf = (
  project: Project,
  catalog: ComponentCatalog,
  history: UndoHistory,
  locale: Language,
  change: Pick<FilmView, 'revision' | 'step'>,
): { view: FilmView; present: Map<string, string> } => {
  const main = mainOf(project)
  const scene = sceneOf(project)
  const clips = allClipsOf(main, scene, catalog)
  const tables = tablesOf(project)
  const localeText = [...tables.values()]
    .flatMap((table) => Object.values(table.values()))
    .filter((value) => typeof value === 'string')
    .join('')
  const canvas = canvasOf(main)
  const captionStyle = captionStyleOf(sheetOf(project)?.rule() ?? '')
  const html = withCanvasSize(
    withFontBlock(contentOf(project, PROJECT_MAIN), clips, catalog, localeText, captionStyle.font),
    canvas,
  )
  const present = new Map(
    [...project.files].map(([path, file]) => [
      path,
      path === PROJECT_MAIN
        ? html
        : path === project.captionsPath
          ? withCaptionDefaults(docOps(file.doc).serialize(), canvas)
          : docOps(file.doc).serialize(),
    ]),
  )
  const table = locale === SOURCE_LOCALE ? undefined : tables.get(locale)
  const shown: ShownLocale =
    locale === SOURCE_LOCALE || table === undefined
      ? SOURCE_SHOWN
      : { code: locale, values: table.values() }
  const sceneContent = present.get(project.captionsPath)
  const voiceModes = voiceModesIn(main)
  const voiceMode = voiceModeOf(voiceModes, shown.code)
  const shownHere = shownIn(shown.code, voiceMode, ownedIn(clips))
  const view: FilmView = {
    html,
    canvas,
    background: rootOf(main)?.inlineStyles['backgroundColor'] ?? headBackground(html),
    clips: clips.filter(shownHere).map((clip) =>
      shown.values !== null && clip.kind === 'caption'
        ? {
            ...clip,
            label: captionLabel(translationOf(shown.values, clip.variable) ?? clip.text),
          }
        : clip,
    ),
    unshownDubs: clips.filter((clip) => !shownHere(clip)),
    voiceMode,
    voiceModes,
    links: new Map(clips.flatMap((clip) => (clip.link === null ? [] : [[clip.id, clip.link]]))),
    durationMs: latestEnd(main, scene),
    captionsProblem: captionsProblem(
      present.get(project.captionsPath) ?? null,
      captionsHostOf(main)?.attributes,
    ),
    captionsScene:
      sceneContent === undefined ? null : { path: project.captionsPath, content: sceneContent },
    captionStyle,
    locale: shown,
    locales: [...tables.keys()],
    bindings: hostBindingsOf(main, clips),
    layers: canvasLayersOf(html, mountsOf(main), present),
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
    ...change,
  }
  return { view, present }
}

/** 主文件根上记的各语言人声设置（见 `voices.ts`）。 */
export const voiceModesIn = (main: Composition) =>
  voiceModesOf(rootOf(main)?.attributes[VOICE_MODES])
