import { mintLinkId } from '@hyperframes/core/media-link'
import type { Composition } from '@hyperframes/sdk'
import { captionsFollowing, dubsFollowing, type CaptionFollowRefusal } from './caption-edit'
import type { CatalogItem, CatalogVariable, ComponentCatalog } from './composition/catalog'
import {
  audioElement,
  type Canvas,
  type CaptionClip,
  type FilmClip,
  type HostClip,
} from './composition/film'
import {
  fieldText,
  LOCALE_BINDINGS,
  localeBindingsAttribute,
  localeVariable,
  localeVariableId,
  textFields,
  type LocaleBindings,
} from './composition/locale-text'
import {
  VOICE_MODES,
  voiceKeyOf,
  voiceModesAttribute,
  voiceModesWithout,
  voiceSettingOf,
  type VoiceSetting,
} from './composition/voices'
import { dubsOverlapped, shownIn, type NewDub } from './dubbing'
import {
  allClipsOf,
  bindingsOf,
  captionsById,
  captionsHostOf,
  clipsOf,
  declaredDefault,
  declares,
  latestEnd,
  rootOf,
  voiceModesIn,
} from './film-view'
import type { Language, ValueTable } from './locales'
import { dubRowFor } from './placement'

/**
 * 将文档 `engine` 根节点尺寸修改为 `canvas`（调用 SDK `setCompositionMetadata` 更新 `data-width` / `data-height`，
 * 运行库据此确定合成画幅）。SDK 修改尺寸时会向根节点写入行内 `width` / `height`，撤销时仅还原为旧值而不移除属性；
 * 若根节点原本无行内宽高，则先显式写入再于变更后置空移除，确保撤销时三步逆序回放使根节点逐字还原至原状。
 */
const resizeRoot = (engine: Composition, canvas: Canvas) => {
  const root = rootOf(engine)
  if (root === undefined) return
  const bare = root.inlineStyles['width'] === undefined && root.inlineStyles['height'] === undefined
  if (bare) engine.setStyle(root.id, { width: `${canvas.width}px`, height: `${canvas.height}px` })
  engine.dispatch({ type: 'setCompositionMetadata', width: canvas.width, height: canvas.height })
  if (bare) engine.setStyle(root.id, { width: null, height: null })
}

/**
 * 在同一事务批次内将工程画布尺寸修改为 `canvas`（仅修改画布本身）：同步更新主文件与字幕场景的根节点宽高（见 `resizeRoot`；
 * 主文件 `<head>` 中的模板尺寸与字幕场景统一样式的默认字号在序列化时随根节点重算，见 `viewOf`）。
 * 既有内容（元素/模板宿主的定位与单句自定义字号）均不按比例换算，保持原有声明值不变。
 *
 * 字幕宿主节点的 `data-width` / `data-height` 保持不改：SDK 将其视作保留属性禁止直接写入，
 * 运行库挂载字幕场景时会自动按场景根节点宽高覆写宿主，且宿主本身通过样式铺满画布。
 */
export const resizeCanvas = (main: Composition, scene: Composition | undefined, canvas: Canvas) => {
  resizeRoot(main, canvas)
  if (scene !== undefined) resizeRoot(scene, canvas)
}

/** 主文件根上的变量 `variable` 的默认值写成 `text`，还没声明时声明上（名字是 `label`）。 */
export const writeDefault = (main: Composition, variable: string, label: string, text: string) => {
  if (!declares(main, variable)) main.declareVariable(localeVariable(variable, label, text))
  else if (declaredDefault(main, variable) !== text) main.setVariableValue(variable, text)
}

const writeBindings = (main: Composition, id: string, bindings: LocaleBindings) =>
  main.setAttribute(id, LOCALE_BINDINGS, localeBindingsAttribute(bindings))

/** 组件或块的片段 `clip` 的文字字段 `field` 改成随语言：根上声明变量（默认值是现在的字），宿主上记下。 */
export const followLocale = (
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
export const pinField = (
  main: Composition,
  tables: Iterable<ValueTable>,
  id: string,
  fieldId: string,
) => {
  const { [fieldId]: variable, ...rest } = bindingsOf(main, id)
  if (variable === undefined) return
  writeBindings(main, id, rest)
  if (declares(main, variable)) main.removeVariableDeclaration(variable)
  for (const table of tables) table.set(variable, null)
}

/**
 * 片段 `clip` 现在还固定着的文字字段：文字字段默认都随语言（品牌名、型号这类翻译时原样给回），
 * 要所有语言共用一份的由用户改成固定。
 */
export const followingByDefault = (
  main: Composition,
  clip: Pick<HostClip, 'id'>,
  item: CatalogItem,
): CatalogVariable[] =>
  textFields(item).filter((field) => bindingsOf(main, clip.id)[field.id] === undefined)

/** 按现在的样子写总长：根上的总长，字幕宿主的时长跟着一样长。 */
export const writeTotal = (main: Composition, scene: Composition | undefined) => {
  const total = latestEnd(main, scene) / 1000
  main.dispatch({ type: 'setCompositionMetadata', duration: total })
  const host = captionsHostOf(main)
  const timing = host === undefined ? undefined : main.getElementTimings()[host.id]
  if (host !== undefined && timing !== undefined && timing.exitAt - timing.enterAt !== total)
    main.setTiming(host.id, { start: 0, duration: total }, { linked: false })
}

export const newClipId = () => `clip-${crypto.randomUUID().slice(0, 8)}`

export const LINK = 'data-link'

/**
 * 新的链接名（也用作分离出来的原声的出处）：照引擎的取法，不和文件里任何元素的编号、链接名、出处重名。
 */
export const newLinkName = (engine: Composition) =>
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
export const setOwnTiming = (
  engine: Composition,
  id: string,
  timing: { start?: number; duration?: number; trackIndex?: number },
) => engine.setTiming(id, timing, { linked: false })

/**
 * 做完 `change`（里面用 `setOwnTiming` 写时间）以后，把做之前根下各元素的链接名原样写回去：
 * 引擎只改一个片段时会解除它和伙伴的链接，联动不该因为挪了、裁了就断掉。
 */
export const keepingLinks = (engine: Composition, change: () => void) => {
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

/** 字幕跟着挪做不到（见 `captionsFollowing`）：整步编辑退回去。 */
export class CaptionsBlocked extends Error {
  readonly reason: CaptionFollowRefusal

  constructor(reason: CaptionFollowRefusal) {
    super(reason)
    this.reason = reason
  }
}

/** 删掉一句字幕：场景里它的元素、主文件根上它的变量、各语言值表里它的值，和各语言里它自己的配音选择。 */
export const removeCaption = (
  main: Composition,
  scene: Composition,
  tables: Iterable<ValueTable>,
  caption: Pick<CaptionClip, 'id' | 'variable'>,
) => {
  scene.removeElement(caption.id)
  if (declares(main, caption.variable)) main.removeVariableDeclaration(caption.variable)
  for (const table of tables) table.set(caption.variable, null)
  const root = rootOf(main)
  const modes = voiceModesIn(main)
  const kept = voiceModesWithout(modes, caption.id)
  if (root !== undefined && kept !== modes)
    main.setAttribute(root.id, VOICE_MODES, voiceModesAttribute(kept))
}

/**
 * 一步编辑做完以后，字幕跟着挪了的视频片段、配音片段走（规则见 `captionsFollowing`，`before` 是这一步之前的
 * 片段）：挪字幕的起点、删掉没了的视频片段的字幕（见 `removeCaption`）。做不到时抛出 `CaptionsBlocked`。
 * 然后各语言的配音片段跟着它配的那句字幕走（见 `dubsFollowing`）。
 */
export const followClips = (
  main: Composition,
  scene: Composition,
  tables: Iterable<ValueTable>,
  before: readonly FilmClip[],
  catalog: ComponentCatalog,
) => {
  const plan = captionsFollowing(before, allClipsOf(main, scene, catalog))
  if ('refusal' in plan) throw new CaptionsBlocked(plan.refusal)
  const captions = captionsById(main, scene)
  for (const [id, start] of plan.starts) setOwnTiming(scene, id, { start: start / 1000 })
  for (const id of plan.removed) {
    const caption = captions.get(id)
    if (caption !== undefined) removeCaption(main, scene, tables, caption)
  }
  const dubs = dubsFollowing(before, allClipsOf(main, scene, catalog))
  for (const [id, start] of dubs.starts) setOwnTiming(main, id, { start: start / 1000 })
  for (const id of dubs.removed) main.removeElement(id)
}

/** 只看配音模式下显示的片段时用：配音模式下原文的配音片段都显示，用不着分哪些字幕属于视频片段。 */
const NO_OWNED: ReadonlySet<string> = new Set()

/**
 * 把一批配音片段（语言 `locale`，原文是 null）写在根下第一个，一起放进第一条这几段时间都空着的「配音」行（见
 * `dubRowFor`，只看这种语言配音时显示着的片段：原文的旁白在别的时候也显示，但那时显示的只会更少）。先把这种语言里
 * 压在它们开始上的已有配音片段收短、该标的标成截了尾（见 `dubsOverlapped`），再找行。一个都没有时不动。
 */
export const addDubElements = (
  engine: Composition,
  catalog: ComponentCatalog,
  rootId: string,
  locale: Language,
  dubs: readonly NewDub[],
) => {
  if (dubs.length === 0) return
  const overlapped = dubsOverlapped(clipsOf(engine, catalog), locale, dubs)
  for (const [id, { duration, trimmed }] of overlapped) {
    setOwnTiming(engine, id, { duration: duration / 1000 })
    // 原来就标了截尾的不去掉
    if (trimmed) engine.setAttribute(id, 'data-dub-trimmed', '')
  }
  const { track, renumber } = dubRowFor(
    clipsOf(engine, catalog),
    dubs,
    shownIn(locale, 'dub', NO_OWNED),
  )
  for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
  for (const { caption, trimmed, text, voice, speed, ...dub } of dubs)
    engine.addElement(
      rootId,
      0,
      audioElement({
        ...dub,
        id: newClipId(),
        track,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        loop: false,
        hidden: false,
        link: null,
        syncOrigin: null,
        dub: { locale, caption, trimmed, text, voice, speed },
        audioGroup: null,
        fxCarve: null,
        fxChain: null,
        automation: null,
      }),
    )
}

/**
 * 语言 `locale`（原文是 null）的人声设置按 `update` 改以后 `data-voice-modes` 要写的值；和现在一样时是 undefined。
 */
export const voiceChange = (
  main: Composition,
  locale: Language,
  update: (setting: VoiceSetting) => VoiceSetting,
): string | null | undefined => {
  const modes = voiceModesIn(main)
  const next = voiceModesAttribute({
    ...modes,
    [voiceKeyOf(locale)]: update(voiceSettingOf(modes, locale)),
  })
  return next === voiceModesAttribute(modes) ? undefined : next
}

/** 把语言 `locale`（原文是 null）的人声设置按 `update` 改；写出来和现在一样时不动。 */
export const writeVoice = (
  main: Composition,
  locale: Language,
  update: (setting: VoiceSetting) => VoiceSetting,
) => {
  const root = rootOf(main)
  const next = voiceChange(main, locale, update)
  if (root !== undefined && next !== undefined) main.setAttribute(root.id, VOICE_MODES, next)
}
