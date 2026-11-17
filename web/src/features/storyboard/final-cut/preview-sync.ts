import { EDIT_BASE_X_ATTR, EDIT_BASE_Y_ATTR } from '@hyperframes/core/runtime/position-edits'
import type { JsonPatchOp } from '@hyperframes/sdk'
import type { CanvasLayer } from './canvas-layers'
import { CAPTION_OWNER } from './composition/captions'
import { FONT_BLOCK_END, FONT_BLOCK_START, PROJECT_MAIN } from './composition/film'
import { cssName } from './layer-edits'
import { localeOfPath, SOURCE_LOCALE, valueIdOf, type Language } from './locales'
import { PREVIEW_VARIABLES } from './preview-document'
import type { LayerRef } from './preview-protocol'
import type { PatchChange, UndoStep } from './undo-history'

/** 预览里的一句字幕：它读的根变量，和它显示的字（原文以外的语言是值表里的字，没翻的是原文）。 */
type PreviewCaption = { variable: string; text: string }

/** 交给预览页的字幕场景。 */
export type PreviewCaptions = {
  /** 场景文件在工程里的路径（相对工程根）。 */
  path: string
  /** 编辑器手里现在的场景文件（没存的改动也在里面）；预览文档里放的就是它（见 `withCaptionsScene`）。 */
  scene: string
  /** 场景里的各句字幕，编号 → 字幕。 */
  captions: ReadonlyMap<string, PreviewCaption>
}

/** 交给预览页的一份 final-cut。 */
export type PreviewFilm = {
  /** 整份预览文档（见 `previewDocument`）。 */
  html: string
  /** 预览域名下的运行库地址（见 `previewRuntimeSrc`）。 */
  runtimeSrc: string
  /** 编辑器里的第几份（见 `FilmView.revision`）。 */
  revision: number
  /** 从上一份到这一份的那一步编辑（见 `FilmView.step`）。 */
  step: UndoStep | null
  /** 预览套着的语言；原文是 `SOURCE_LOCALE`。 */
  locale: Language
  /** 工程里主文件、字幕场景和值表以外的文件变过几次；变了要整份重新加载。 */
  filesRevision: number
  /** 字幕场景；工程里还没有时是 null。 */
  captions: PreviewCaptions | null
  /** 画面上的层（见 canvas-layers.ts）：组件文件里改了的层按它找到画面里的那几处。 */
  layers: readonly CanvasLayer[]
}

/** 组件文件里改了的一层：画面里的哪一处，行内样式（CSS 的写法）和属性改成什么（null 是去掉）。 */
export type LayerWrite = {
  ref: LayerRef
  styles: Record<string, string | null>
  attributes: Record<string, string | null>
}

/**
 * 换上一份 final-cut 的办法：把主文件的补丁（`patches`）和字幕场景的补丁（`captions`）直接打进正在播的那一份，
 * 字体块里的中文字体规则变了时先换成 `fonts`（`<style>` 的内容），组件文件里改了的层直接改（`layers`）；或者
 * 整份重新加载。
 */
export type PreviewSync =
  | {
      kind: 'live'
      patches: readonly JsonPatchOp[]
      captions: readonly JsonPatchOp[]
      layers?: readonly LayerWrite[]
      fonts?: string
    }
  | { kind: 'reload' }

const RELOAD: PreviewSync = { kind: 'reload' }

// 套语言的那段脚本另算：字幕的字靠补丁改（见 `localizedTexts`），别的值变了这一步里有值表的改动、整份重新加载
const VARIABLES_SCRIPT = new RegExp(`<script ${PREVIEW_VARIABLES}>[\\s\\S]*?</script>`)

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 字体块里的中文字体规则另算：浏览器按换上的规则取新字形，实测和重新加载一样；块里的样式表链接变了照旧重新加载
const FONT_STYLE = new RegExp(
  `(${escapeRegExp(FONT_BLOCK_START)}[\\s\\S]*?<style>)([\\s\\S]*?)(</style>\\s*${escapeRegExp(FONT_BLOCK_END)})`,
)

const headOf = (html: string) => /<head[^>]*>[\s\S]*?<\/head>/i.exec(html)?.[0] ?? ''

/** `<head>` 里除了套语言的脚本和中文字体规则以外的部分。 */
const fixedHeadOf = (html: string) =>
  headOf(html).replace(VARIABLES_SCRIPT, '').replace(FONT_STYLE, '$1$3')

/** 字体块里中文字体规则（`<style>` 的内容）；没有字体块时是 undefined。 */
const fontStyleOf = (html: string) => FONT_STYLE.exec(headOf(html))?.[2]

// JSON Pointer 里的 `~1`、`~0` 是 `/`、`~`
const unescapePointer = (segment: string) => segment.replaceAll('~1', '/').replaceAll('~0', '~')
const escapePointer = (segment: string) => segment.replaceAll('~', '~0').replaceAll('/', '~1')

/** `/elements/<编号>` 和它下面一层的 `/<种类>/<名字>`（改字是 `/text`，没有名字）。 */
const ELEMENT = /^\/elements\/([^/]+)(?:\/([^/]+)(?:\/(.+))?)?$/

// 画面上挪、缩放、转一层写的（见 layer-edits.ts）：挪是 SDK `moveElement` 的这几个属性，打完预览页按它们重新摆
const POSITION_ATTRIBUTES = ['data-x', 'data-y', EDIT_BASE_X_ATTR, EDIT_BASE_Y_ATTR]
// 缩放、转写的行内样式（SDK 的属性名）：浏览器直接按行内样式画
const GEOMETRY_STYLES = [
  ...['width', 'height', 'boxSizing', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'],
  ...['flexBasis', 'flexGrow', 'flexShrink', 'display', 'rotate', 'transform'],
]

// 实测过打进去和重新加载效果一样的几种改动；别的（贴片、场景宿主的值、脚本……）运行库只在加载时读
const LIVE_TIMING = new Set(['start', 'duration', 'trackIndex'])
const LIVE_ATTRIBUTES = new Set([
  ...['data-hidden', 'data-media-start', 'data-volume', 'muted'],
  ...POSITION_ATTRIBUTES,
])
const LIVE_STYLES = new Set(['zIndex', ...GEOMETRY_STYLES])

const htmlOf = (value: unknown) =>
  typeof value === 'object' && value !== null && 'html' in value && typeof value.html === 'string'
    ? value.html
    : undefined

const isMediaElement = (value: unknown) => /^\s*<(video|audio)[\s>]/i.test(htmlOf(value) ?? '')

/** 补丁改的根变量：变量的声明、默认值，或根上同名的 CSS 变量（SDK 改变量时一起写）；都不是时是 undefined。 */
const variableOf = (path: string): string | undefined => {
  const matched =
    /^\/(?:variables|variableDeclarations)\/(.+)$/.exec(path) ??
    /^\/elements\/[^/]+\/inlineStyles\/--(.+)$/.exec(path)
  return matched === null ? undefined : unescapePointer(matched[1] ?? '')
}

/**
 * 主文件的这条补丁能不能直接打。字幕的根变量能：各句的字由场景里它自己的字显示，运行库加载以后不再读根变量，
 * 打进去只为副本会话和编辑器对得上。原文以外的语言下别的都不行（套语言改过发出去的那一份，不是引擎补丁）。
 */
const isLiveMain = (
  patch: JsonPatchOp,
  foreign: boolean,
  captionVariables: ReadonlySet<string>,
) => {
  const variable = variableOf(patch.path)
  if (variable !== undefined) return captionVariables.has(variable)
  if (foreign) return false
  if (patch.path === '/metadata/duration') return true
  const element = ELEMENT.exec(patch.path)
  if (element === null) return false
  const [, , kind, name = ''] = element
  switch (kind) {
    // 加、删片段本身：删哪种都行，加的只能是视频、音频（宿主要运行库挂载）
    case undefined:
      return patch.op === 'remove' || isMediaElement(patch.value)
    case 'timing':
      return LIVE_TIMING.has(name)
    case 'attributes':
      return LIVE_ATTRIBUTES.has(name)
    case 'inlineStyles':
      return LIVE_STYLES.has(name)
    default:
      return false
  }
}

const SCENE_TIMING = new Set(['start', 'duration'])
// 一句的字体、字色（见 captions.ts 的 `captionStyles`）：浏览器直接按行内样式画；字体用到新的样式表链接时
// `<head>` 变了，照旧整份重新加载。画面上挪、缩放、转一句也是
const SCENE_STYLES = new Set(['color', 'fontFamily', ...GEOMETRY_STYLES])
const SCENE_ATTRIBUTES = new Set([CAPTION_OWNER, ...POSITION_ATTRIBUTES])

/**
 * 字幕场景的这条补丁能不能直接打：加、删一句（加的不能是要运行库挂载的宿主），改一句的起止、字、属于哪个片段、
 * 字体和字色，在画面上挪、缩放、转一句。
 */
const isLiveScene = (patch: JsonPatchOp) => {
  const element = ELEMENT.exec(patch.path)
  if (element === null) return false
  const [, , kind, name = ''] = element
  switch (kind) {
    case undefined: {
      if (patch.op === 'remove') return true
      const html = htmlOf(patch.value) ?? ''
      return (
        patch.op === 'add' &&
        /^\s*<div[\s>]/i.test(html) &&
        !/\sdata-composition-src\s*=/i.test(html)
      )
    }
    case 'timing':
      return SCENE_TIMING.has(name)
    case 'text':
      return name === ''
    case 'attributes':
      return SCENE_ATTRIBUTES.has(name)
    case 'inlineStyles':
      return SCENE_STYLES.has(name)
    default:
      return false
  }
}

/** 补丁里最后写下的总长（秒）；没写时是 undefined。 */
const durationIn = (patches: readonly JsonPatchOp[]) =>
  patches.findLast((patch) => patch.path === '/metadata/duration' && patch.op !== 'remove')?.value

// 运行库的总长只能往长里改（预览页经它的 set-root-duration 改），变短时整份重新加载
const shortens = (change: PatchChange) => {
  const after = durationIn(change.patches)
  if (after === undefined) return false
  const before = durationIn(change.inversePatches)
  return typeof after !== 'number' || typeof before !== 'number' || after < before
}

const variablesOf = (captions: PreviewCaptions | null) =>
  [...(captions?.captions.values() ?? [])].map((caption) => caption.variable)

/**
 * 原文以外的语言下，这一步以后各句该显示的字：加载时运行库按值表写进各句，之后值表改了、字幕加回来了、
 * 原文改了它都不再写。这一步加了、改了字（`scenePatches`）或者显示的字变了的那几句，各补一条改字的补丁。
 */
const localizedTexts = (
  shown: PreviewCaptions | null,
  next: PreviewCaptions,
  scenePatches: readonly JsonPatchOp[],
): JsonPatchOp[] => {
  const touched = new Set(
    scenePatches.flatMap((patch) => {
      const element = ELEMENT.exec(patch.path)
      if (element === null) return []
      const [, id = '', kind] = element
      return (kind === undefined && patch.op !== 'remove') || kind === 'text'
        ? [unescapePointer(id)]
        : []
    }),
  )
  return [...next.captions]
    .filter(([id, caption]) => touched.has(id) || shown?.captions.get(id)?.text !== caption.text)
    .map(([id, caption]) => ({
      op: 'replace',
      path: `/elements/${escapePointer(id)}/text`,
      value: caption.text,
    }))
}

/**
 * 预览页装着 `shown`（还没装好或正在重新加载时是 null）、要换成 `next` 时怎么换。`next` 正好是 `shown` 的下一份、
 * 语言和 `<head>`（中文字体规则除外，变了时带上新的）等条件都没变，而且这一步的改动都能直接打时，把主文件、
 * 字幕场景各自的补丁打进去：主文件见 `isLiveMain`（总长不能变短），字幕场景见 `isLiveScene`；值表只能改别的语言的（预览里看不到），
 * 或者预览套着的这种语言里字幕的字（见 `localizedTexts`）。拿不准的都整份重新加载。
 */
export function previewSync(shown: PreviewFilm | null, next: PreviewFilm): PreviewSync {
  const { step } = next
  if (
    shown === null ||
    step === null ||
    next.revision !== shown.revision + 1 ||
    next.locale !== shown.locale ||
    next.runtimeSrc !== shown.runtimeSrc ||
    next.filesRevision !== shown.filesRevision ||
    next.captions?.path !== shown.captions?.path ||
    fixedHeadOf(next.html) !== fixedHeadOf(shown.html)
  )
    return RELOAD
  const foreign = next.locale !== SOURCE_LOCALE
  const captionVariables = new Set(
    [...variablesOf(shown.captions), ...variablesOf(next.captions)].filter((id) => id !== ''),
  )
  const patches: JsonPatchOp[] = []
  const captions: JsonPatchOp[] = []
  const layers: LayerWrite[] = []
  const mounted = new Set(
    next.layers.flatMap((layer) =>
      layer.scope === null || layer.file === next.captions?.path ? [] : [layer.file],
    ),
  )
  for (const change of step) {
    if (change.file === PROJECT_MAIN) {
      if (
        shortens(change) ||
        !change.patches.every((patch) => isLiveMain(patch, foreign, captionVariables))
      )
        return RELOAD
      patches.push(...change.patches)
      continue
    }
    if (change.file === next.captions?.path) {
      if (!change.patches.every(isLiveScene)) return RELOAD
      captions.push(...change.patches)
      continue
    }
    if (mounted.has(change.file)) {
      layers.push(...layerWrites(change, next.layers))
      continue
    }
    const locale = localeOfPath(change.file)
    if (
      locale === undefined ||
      (locale === next.locale &&
        !change.patches.every((patch) => captionVariables.has(valueIdOf(patch.path))))
    )
      return RELOAD
  }
  if (foreign && next.captions !== null)
    captions.push(...localizedTexts(shown.captions, next.captions, captions))
  const fonts = fontStyleOf(next.html)
  return {
    kind: 'live',
    patches,
    captions,
    ...(layers.length === 0 ? {} : { layers }),
    ...(fonts === fontStyleOf(shown.html) || fonts === undefined ? {} : { fonts }),
  }
}

/**
 * 组件文件的这一步改动里，改层的行内样式、属性的那些：按层表找到画面里的每一处（同一个条目加了几次，几个宿主
 * 挂着同一个文件），各改一次。别的改动不打：预览里这份组件是从工程里取的，存下以后工程文件变了整份重新加载。
 */
function layerWrites(change: PatchChange, table: readonly CanvasLayer[]): LayerWrite[] {
  const byElement = new Map<
    string,
    { styles: Record<string, string | null>; attributes: Record<string, string | null> }
  >()
  for (const patch of change.patches) {
    const element = ELEMENT.exec(patch.path)
    if (element === null) continue
    const [, id = '', kind, name = ''] = element
    if (kind !== 'inlineStyles' && kind !== 'attributes') continue
    const written = byElement.get(unescapePointer(id)) ?? { styles: {}, attributes: {} }
    const value = patch.op === 'remove' || typeof patch.value !== 'string' ? null : patch.value
    const field = unescapePointer(name)
    if (kind === 'inlineStyles') written.styles[cssName(field)] = value
    else written.attributes[field] = value
    byElement.set(unescapePointer(id), written)
  }
  return table.flatMap((layer) => {
    const written = layer.file === change.file ? byElement.get(layer.element.hfId) : undefined
    return written === undefined || layer.scope === null
      ? []
      : [{ ref: { scope: layer.scope, selector: layer.selector, index: layer.index }, ...written }]
  })
}
