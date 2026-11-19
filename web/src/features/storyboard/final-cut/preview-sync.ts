import { HF_AUDIO_AUTOMATION_ATTR } from '@hyperframes/core/audio-automation'
import { HF_AUDIO_CARVE_ATTR } from '@hyperframes/core/audio-carve'
import { HF_AUDIO_FX_ATTR } from '@hyperframes/core/audio-fx'
import { HF_AUDIO_GROUP_ATTR } from '@hyperframes/core/audio-groups'
import { EDIT_BASE_X_ATTR, EDIT_BASE_Y_ATTR } from '@hyperframes/core/runtime/position-edits'
import type { JsonPatchOp } from '@hyperframes/sdk'
import { CAPTION_OWNER } from './composition/captions'
import { FONT_BLOCK_END, FONT_BLOCK_START, PROJECT_MAIN } from './composition/film'
import { localeOfPath, SOURCE_LOCALE, valueIdOf, type Language } from './locales'
import { PREVIEW_VARIABLES } from './preview-document'
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
}

/**
 * 换上一份 final-cut 的办法：把主文件的补丁（`patches`）和字幕场景的补丁（`captions`）直接打进正在播的那一份，
 * 字体块里的中文字体规则变了时先换成 `fonts`（`<style>` 的内容）；或者整份重新加载。
 */
export type PreviewSync =
  | {
      kind: 'live'
      patches: readonly JsonPatchOp[]
      captions: readonly JsonPatchOp[]
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

// 画布编辑写入的属性（见 layer-edits.ts）：普通图层位移通过 SDK `moveElement` 写这四个属性，补丁应用后由预览页重算位置
const POSITION_ATTRIBUTES = ['data-x', 'data-y', EDIT_BASE_X_ATTR, EDIT_BASE_Y_ATTR]
// 画布缩放、旋转及贴片/场景宿主变换写入的行内样式（SDK 驼峰属性名），浏览器可实时生效无需重载
const GEOMETRY_STYLES = [
  ...['width', 'height', 'boxSizing', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'],
  ...['flexBasis', 'flexGrow', 'flexShrink', 'display', 'rotate', 'transform'],
  ...['translate', 'scale'],
]

// 经验证可直接增量打补丁且与整份重载等价的改动范围（其余如宿主变量值、脚本等仅在运行库初始加载时读取）
const LIVE_TIMING = new Set(['start', 'duration', 'trackIndex'])
const LIVE_ATTRIBUTES = new Set([
  ...['data-hidden', 'data-media-start', 'data-volume', 'muted'],
  ...POSITION_ATTRIBUTES,
])
const LIVE_STYLES = new Set(['zIndex', ...GEOMETRY_STYLES])

// 调音写的属性，实测打进去（播着、停着、撤销，值变了、第一次出现、去掉）和重新加载一样：效果链、曲线运行库在播的
// 片段上自己跟，视频第一次有它们时预览页原地跳一下（见 preview-page.ts）；片段上的组没有自己的效果，换组声音不变；
// 压低设置运行库不读。套语言不改这几个属性，原文以外的语言下也能打
const MIX_ATTRIBUTES = new Set([
  HF_AUDIO_FX_ATTR,
  HF_AUDIO_AUTOMATION_ATTR,
  HF_AUDIO_GROUP_ATTR,
  HF_AUDIO_CARVE_ATTR,
])

/** 补丁改的调音属性在哪个片段上；不是调音属性时是 undefined。 */
const mixTargetOf = (path: string): string | undefined => {
  const element = ELEMENT.exec(path)
  if (element === null) return undefined
  const [, id = '', kind, name = ''] = element
  return kind === 'attributes' && MIX_ATTRIBUTES.has(unescapePointer(name))
    ? unescapePointer(id)
    : undefined
}

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
 * 打进去只为副本会话和编辑器对得上。调音的属性能，只要片段在预览的那一份（`preview`）里：别的语言的配音片段、
 * 隐藏的片段不在。总长没变（`totalKept`）时能：编辑器每步都重写一次总长，没变的这条什么都不改。原文以外的
 * 语言下别的都不行（套语言改过发出去的那一份，不是引擎补丁）。
 */
const isLiveMain = (
  patch: JsonPatchOp,
  foreign: boolean,
  captionVariables: ReadonlySet<string>,
  preview: string,
  totalKept: boolean,
) => {
  const variable = variableOf(patch.path)
  if (variable !== undefined) return captionVariables.has(variable)
  const mixTarget = mixTargetOf(patch.path)
  if (mixTarget !== undefined) return preview.includes(` data-hf-id="${mixTarget}"`)
  if (patch.path === '/metadata/duration') return !foreign || totalKept
  if (foreign) return false
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
// 一句的字体、字色、字号和跟着字号的描边、投影（见 captions.ts 的 `captionStyles`）：浏览器直接按行内样式画；
// 字体用到新的样式表链接时 `<head>` 变了，照旧整份重新加载。画面上挪、缩放、转一句也是
const SCENE_STYLES = new Set([
  'color',
  'fontFamily',
  'fontSize',
  'WebkitTextStroke',
  'textShadow',
  ...GEOMETRY_STYLES,
])
const SCENE_ATTRIBUTES = new Set([CAPTION_OWNER, ...POSITION_ATTRIBUTES])

/**
 * 字幕场景的这条补丁能不能直接打：加、删一句（加的不能是要运行库挂载的宿主），改一句的起止、字、属于哪个片段、
 * 字体、字色和字号，在画面上挪、缩放、转一句。
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

/** 这一步写了总长、但和原来一样。 */
const keepsTotal = (change: PatchChange) => {
  const after = durationIn(change.patches)
  return typeof after === 'number' && after === durationIn(change.inversePatches)
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
  for (const change of step) {
    if (change.file === PROJECT_MAIN) {
      const kept = keepsTotal(change)
      if (
        shortens(change) ||
        !change.patches.every((patch) =>
          isLiveMain(patch, foreign, captionVariables, next.html, kept),
        )
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
    ...(fonts === fontStyleOf(shown.html) || fonts === undefined ? {} : { fonts }),
  }
}
