import type { CatalogItem, CatalogVariable, ComponentCatalog, VariableValue } from './catalog'
import { cjkFontFaces } from './fonts'
import { escapeAttribute, jsonAttribute, seconds } from './html'

/**
 * 成片文件：一份 HTML，时间线上每个片段是根下面的一个标签。
 *
 * 文件不带脚本（根上标 `data-no-timeline`）。`<head>`、根上的属性和 `<html>` 上的变量声明都由
 * 这里按片段算出来，不单独保存。
 */
export interface Film {
  canvas: Canvas
  clips: FilmClip[]
}

export interface Canvas {
  width: number
  height: number
}

export type FilmClip = VideoClip | HostClip | AudioClip
export type ClipKind = FilmClip['kind']
/** 用素材地址的片段：地址写在片段上，并绑到按记录编号取名的变量。 */
export type MediaClip = VideoClip | AudioClip

/**
 * 三种片段共有的部分。时间都是毫秒。
 *
 * `track` 是它在自己那个区的第几行，只管显示：视频片段和组件或块的片段在画面区，音频片段在声音区，
 * 两个区的行号各算各的。
 * `hidden` 的片段留在时间线上、占着它的时间，预览和导出里都不出现、不出声；没隐藏时文件里不写。
 */
interface ClipBase {
  id: string
  label: string
  start: number
  duration: number
  track: number
  hidden: boolean
}

/**
 * 视频片段、音频片段共有的声音和播放：`mediaStart` 是从素材的第几毫秒开始放，`volume` 是增益的倍数
 * （0.5 比 1 低 6 dB），`playbackRate` 是速度的倍数（片段在成片里占的时长不跟着变，用掉的素材是
 * 时长 × 速度），`fadeIn` / `fadeOut` 是声音淡入淡出的毫秒数。速度是 1、淡入淡出是 0 时文件里不写。
 */
interface MediaBase extends ClipBase {
  jobId: string
  src: string
  mediaStart: number
  volume: number
  playbackRate: number
  fadeIn: number
  fadeOut: number
}

/**
 * 视频片段：一段素材片，`src` 是素材片记录上的地址。`muted` 时不出声。
 *
 * 两个画面区的片段同时出现时谁盖住谁看 `z`（叠放顺序）：大的在上面，一样大时文件里写在后面的在上面。
 * `z` 是 0 时文件里不写。
 */
export interface VideoClip extends MediaBase {
  kind: 'video'
  muted: boolean
  z: number
}

/**
 * 组件或块的片段：组件库里的一个条目。`item` 是条目的名字，`src` 是条目的文件。
 * 条目没写尺寸或和画面一样大时铺满画面；写了别的尺寸时按原比例缩到放得下、居中（写在 `<head>` 里）。
 * `playbackStart` 是从条目自己的第几毫秒开始播，`values` 是它的可填项取值；叠放顺序同视频片段。
 * `playbackStart` 是 0 时文件里不写。
 */
export interface HostClip extends ClipBase {
  kind: 'host'
  item: string
  src: string
  playbackStart: number
  values: Record<string, VariableValue>
  z: number
}

/**
 * 音频片段：一条音频记录，`src` 是记录上的地址。`loop` 时音频比片段短也一直重复着播，不循环时文件里不写。
 * 隐藏的音频片段不出声。
 */
export interface AudioClip extends MediaBase {
  kind: 'audio'
  loop: boolean
}

export const isMediaClip = (clip: FilmClip): clip is MediaClip => clip.kind !== 'host'

export interface FilmVariable {
  id: string
  type: 'string'
  label: string
  default: string
}

export const FILM_ID = 'film'
export const MIN_CLIP_MS = 100
export const SOURCE_LABEL = '素材片'
export const AUDIO_SOURCE_LABEL = '音频'

/**
 * 片段上的一个属性。默认是必须写的；`optional` 的取默认值时不写；`fixed` 的只能是这个值
 * （可选又固定的，写就是写这个值）。
 */
export interface AttributeRule {
  optional?: true
  fixed?: string
}

const REQUIRED: AttributeRule = {}
const OPTIONAL: AttributeRule = { optional: true }
// 隐藏标记和叠放顺序（片段上唯一能带的样式）写在最前面，和 SDK 存出来的一样
const HIDDEN: AttributeRule = { optional: true, fixed: '' }

/**
 * 三种片段的写法：标签和能带的属性（按写出的先后）。写出、读回和渲染服务的检查都按这张表。
 */
export const CLIP_SHAPES = {
  video: {
    tag: 'video',
    attributes: {
      'data-hidden': HIDDEN,
      style: OPTIONAL,
      id: REQUIRED,
      'data-hf-id': REQUIRED,
      class: { fixed: 'clip picture' },
      'data-label': REQUIRED,
      src: REQUIRED,
      'data-var-src': REQUIRED,
      'data-start': REQUIRED,
      'data-duration': REQUIRED,
      'data-media-start': REQUIRED,
      'data-track-index': REQUIRED,
      'data-volume': REQUIRED,
      'data-playback-rate': OPTIONAL,
      'data-fade-in': OPTIONAL,
      'data-fade-out': OPTIONAL,
      // 有声音时写 data-has-audio，静音时换成 muted，两个不同时写
      'data-has-audio': { optional: true, fixed: 'true' },
      muted: { optional: true, fixed: 'true' },
      playsinline: { fixed: '' },
      preload: { fixed: 'auto' },
    },
  },
  host: {
    tag: 'div',
    attributes: {
      'data-hidden': HIDDEN,
      style: OPTIONAL,
      id: REQUIRED,
      'data-hf-id': REQUIRED,
      class: { fixed: 'clip component' },
      'data-label': REQUIRED,
      'data-composition-id': REQUIRED,
      'data-composition-src': REQUIRED,
      'data-start': REQUIRED,
      'data-duration': REQUIRED,
      'data-playback-start': OPTIONAL,
      'data-track-index': REQUIRED,
      'data-variable-values': REQUIRED,
    },
  },
  audio: {
    tag: 'audio',
    attributes: {
      'data-hidden': HIDDEN,
      id: REQUIRED,
      'data-hf-id': REQUIRED,
      class: { fixed: 'clip audio' },
      'data-label': REQUIRED,
      src: REQUIRED,
      'data-var-src': REQUIRED,
      'data-start': REQUIRED,
      'data-duration': REQUIRED,
      'data-media-start': REQUIRED,
      'data-track-index': REQUIRED,
      'data-volume': REQUIRED,
      'data-playback-rate': OPTIONAL,
      'data-fade-in': OPTIONAL,
      'data-fade-out': OPTIONAL,
      loop: { optional: true, fixed: 'true' },
    },
  },
} as const satisfies Record<
  ClipKind,
  { tag: string; attributes: Readonly<Record<string, AttributeRule>> }
>

export type ClipAttribute = {
  [Kind in ClipKind]: keyof (typeof CLIP_SHAPES)[Kind]['attributes']
}[ClipKind]

/** 一个片段要写的属性值；可选属性是 undefined 时不写。 */
type Attributes = Partial<Record<ClipAttribute, string | undefined>>

/** 按标签认片段：成片的根下面每种标签只对应一种片段。 */
export function clipKindOfTag(tag: string): ClipKind | undefined {
  const kinds = Object.keys(CLIP_SHAPES) as ClipKind[]
  return kinds.find((kind) => CLIP_SHAPES[kind].tag === tag)
}

export const sourceVariableId = (jobId: string): string => `src-${jobId}`

/** 素材地址的变量：一条记录一个，默认值就是片段上写的地址。 */
export function sourceVariable(jobId: string, src: string, label = SOURCE_LABEL): FilmVariable {
  return { id: sourceVariableId(jobId), type: 'string', label, default: src }
}

export function filmDurationMs(film: Film): number {
  return Math.max(0, ...film.clips.map((clip) => clip.start + clip.duration))
}

export function filmVariables(film: Film): FilmVariable[] {
  const bySource = new Map(
    film.clips
      .filter(isMediaClip)
      .map((clip) => [
        clip.jobId,
        sourceVariable(
          clip.jobId,
          clip.src,
          clip.kind === 'audio' ? AUDIO_SOURCE_LABEL : SOURCE_LABEL,
        ),
      ]),
  )
  return [...bySource.values()]
}

/** 按表里的先后写出一个片段；可选属性没给值就不写，固定的空值只写属性名。 */
function clipElement(kind: ClipKind, values: Attributes): string {
  const { tag, attributes } = CLIP_SHAPES[kind]
  const written = Object.entries(attributes).flatMap(([name, rule]: [string, AttributeRule]) => {
    const given = values[name as ClipAttribute]
    const value = rule.optional ? given : (rule.fixed ?? given)
    if (value === undefined) return []
    if (value === '' && rule.fixed === '' && !rule.optional) return [` ${name}`]
    return [` ${name}="${escapeAttribute(value)}"`]
  })
  return `<${tag}${written.join('')}></${tag}>`
}

const commonValues = (clip: FilmClip): Attributes => ({
  'data-hidden': clip.hidden ? '' : undefined,
  id: clip.id,
  'data-hf-id': clip.id,
  'data-label': clip.label,
  'data-start': seconds(clip.start),
  'data-duration': seconds(clip.duration),
  'data-track-index': String(clip.track),
})

const stacking = (z: number) => (z > 0 ? `z-index: ${z}` : undefined)
const unlessZero = (ms: number) => (ms > 0 ? seconds(ms) : undefined)

const mediaValues = (clip: MediaClip): Attributes => ({
  src: clip.src,
  'data-var-src': sourceVariableId(clip.jobId),
  'data-media-start': seconds(clip.mediaStart),
  'data-volume': String(clip.volume),
  'data-playback-rate': clip.playbackRate === 1 ? undefined : String(clip.playbackRate),
  'data-fade-in': unlessZero(clip.fadeIn),
  'data-fade-out': unlessZero(clip.fadeOut),
})

export function videoClip(clip: VideoClip): string {
  return clipElement('video', {
    ...commonValues(clip),
    style: stacking(clip.z),
    ...mediaValues(clip),
    'data-has-audio': clip.muted ? undefined : 'true',
    muted: clip.muted ? 'true' : undefined,
  })
}

export function hostClip(clip: HostClip): string {
  return clipElement('host', {
    ...commonValues(clip),
    style: stacking(clip.z),
    'data-composition-id': clip.item,
    'data-composition-src': clip.src,
    'data-playback-start': unlessZero(clip.playbackStart),
    'data-variable-values': JSON.stringify(clip.values),
  })
}

export function audioClip(clip: AudioClip): string {
  return clipElement('audio', {
    ...commonValues(clip),
    ...mediaValues(clip),
    loop: clip.loop ? 'true' : undefined,
  })
}

export function writeClip(clip: FilmClip): string {
  switch (clip.kind) {
    case 'video':
      return videoClip(clip)
    case 'host':
      return hostClip(clip)
    case 'audio':
      return audioClip(clip)
  }
}

const SECONDS = /^\d+(\.\d+)?$/
const INTEGER = /^\d+$/

type AttributeSource = Readonly<Record<string, string>>

const millisecondsOf = (value: string | undefined): number | undefined =>
  value !== undefined && SECONDS.test(value) ? Math.round(Number(value) * 1000) : undefined

/** 三种片段共有的部分；起点、时长没写或不是秒数时返回 undefined。 */
function commonOf(id: string, attributes: AttributeSource) {
  const start = millisecondsOf(attributes['data-start'])
  const duration = millisecondsOf(attributes['data-duration'])
  if (start === undefined || duration === undefined) return undefined
  return {
    id,
    label: attributes['data-label'] ?? '',
    start,
    duration,
    track: Number(attributes['data-track-index'] ?? 0),
    hidden: attributes['data-hidden'] !== undefined,
  }
}

const stackingOf = (zIndex: string | undefined) =>
  zIndex === undefined || !INTEGER.test(zIndex) ? 0 : Number(zIndex)

/** 视频片段和音频片段的地址、入点和声音、播放；没写全时返回 undefined。 */
function mediaOf(attributes: AttributeSource) {
  const jobId = attributes['data-var-src']?.replace(/^src-/, '')
  const { src } = attributes
  const mediaStart = millisecondsOf(attributes['data-media-start'])
  const fadeIn = millisecondsOf(attributes['data-fade-in'] ?? '0')
  const fadeOut = millisecondsOf(attributes['data-fade-out'] ?? '0')
  if (
    jobId === undefined ||
    src === undefined ||
    mediaStart === undefined ||
    fadeIn === undefined ||
    fadeOut === undefined
  )
    return undefined
  return {
    jobId,
    src,
    mediaStart,
    volume: Number(attributes['data-volume'] ?? 1),
    playbackRate: Number(attributes['data-playback-rate'] ?? 1),
    fadeIn,
    fadeOut,
  }
}

/**
 * 从片段的属性读回视频片段；不是 `videoClip` 写出来的那种片段时返回 undefined。
 * `zIndex` 是片段的行内样式里的叠放顺序（SDK 的元素快照把样式和属性分开给）。
 */
export function videoFromAttributes(
  id: string,
  attributes: AttributeSource,
  zIndex?: string,
): VideoClip | undefined {
  const common = commonOf(id, attributes)
  const media = mediaOf(attributes)
  if (common === undefined || media === undefined) return undefined
  return {
    kind: 'video',
    ...common,
    ...media,
    muted: attributes['muted'] !== undefined,
    z: stackingOf(zIndex),
  }
}

/** 从片段的属性读回组件或块的片段；不是 `hostClip` 写出来的那种片段时返回 undefined。`zIndex` 同视频片段。 */
export function hostFromAttributes(
  id: string,
  attributes: AttributeSource,
  zIndex?: string,
): HostClip | undefined {
  const common = commonOf(id, attributes)
  const item = attributes['data-composition-id']
  const src = attributes['data-composition-src']
  const playbackStart = millisecondsOf(attributes['data-playback-start'] ?? '0')
  const values = variableValuesOf(attributes['data-variable-values'])
  if (
    common === undefined ||
    item === undefined ||
    src === undefined ||
    playbackStart === undefined ||
    values === undefined
  )
    return undefined
  return {
    kind: 'host',
    ...common,
    item,
    src,
    playbackStart,
    values,
    z: stackingOf(zIndex),
  }
}

/** 从片段的属性读回音频片段；不是 `audioClip` 写出来的那种片段时返回 undefined。 */
export function audioFromAttributes(
  id: string,
  attributes: AttributeSource,
): AudioClip | undefined {
  const common = commonOf(id, attributes)
  const media = mediaOf(attributes)
  if (common === undefined || media === undefined) return undefined
  return { kind: 'audio', ...common, ...media, loop: attributes['loop'] !== undefined }
}

export function clipFromAttributes(
  kind: ClipKind,
  id: string,
  attributes: AttributeSource,
  zIndex?: string,
): FilmClip | undefined {
  switch (kind) {
    case 'video':
      return videoFromAttributes(id, attributes, zIndex)
    case 'host':
      return hostFromAttributes(id, attributes, zIndex)
    case 'audio':
      return audioFromAttributes(id, attributes)
  }
}

const isVariableValue = (value: unknown): value is VariableValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** 组件的可填项取值：一个普通 JSON 对象，值是字符串、数字或布尔；不是这样时返回 undefined。 */
export function variableValuesOf(
  json: string | undefined,
): Record<string, VariableValue> | undefined {
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const values: Record<string, VariableValue> = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isVariableValue(value)) return undefined
    values[id] = value
  }
  return values
}

const itemOf = (clip: HostClip, catalog: ComponentCatalog): CatalogItem | undefined =>
  catalog.items.find((candidate) => candidate.name === clip.item)

/**
 * 字体类可填项取到的字体族：片段上填了用填的，没填用默认值。取到的是空的、或者组件库里没有这个字体族时
 * 是 undefined——取值是用户写的字符串，只认组件库里的名字才能写进样式。
 */
function fontOf(
  clip: HostClip,
  variable: CatalogVariable,
  catalog: ComponentCatalog,
): string | undefined {
  const value = clip.values[variable.id] ?? variable.default
  return typeof value === 'string' && Object.hasOwn(catalog.fonts, value) ? value : undefined
}

/**
 * 成片要声明的字体：用到的条目自带的字体族，加上字体类可填项取到的字体族；
 * 中文字体按组件值里的文字和条目里出现的字声明。组件库里没有的字体族不声明。
 */
function fontsOf(film: Film, catalog: ComponentCatalog): { families: string[]; text: string } {
  const families = new Set<string>()
  let text = ''
  const used = new Set<string>()
  for (const clip of film.clips) {
    if (clip.kind !== 'host') continue
    text += Object.values(clip.values)
      .filter((value) => typeof value === 'string')
      .join('')
    const item = itemOf(clip, catalog)
    if (item === undefined) continue
    if (!used.has(item.name)) {
      used.add(item.name)
      text += item.chars
      for (const family of item.fonts) families.add(family)
    }
    for (const variable of item.variables) {
      if (variable.type !== 'font') continue
      const family = fontOf(clip, variable, catalog)
      if (family !== undefined) families.add(family)
    }
  }
  return {
    families: [...families].filter((family) => Object.hasOwn(catalog.fonts, family)).sort(),
    text,
  }
}

const round4 = (value: number) => String(Math.round(value * 10_000) / 10_000)

/**
 * 一个组件或块的片段在 `<head>` 里的规则；不用写时返回 undefined。片段上的样式只能是叠放顺序，所以写在这里、按片段的编号认。
 * - 条目有尺寸、和画面不一样大：按原比例缩到放得下，居中。
 * - 第一个字体类可填项取到了字体：标题和正文的字体变量都换成它，中文字形退到组件库的中文字体。
 */
function itemRule(clip: HostClip, canvas: Canvas, catalog: ComponentCatalog): string | undefined {
  const item = itemOf(clip, catalog)
  if (item === undefined) return undefined
  const declarations: string[] = []
  const { size } = item
  if (size !== null && (size.width !== canvas.width || size.height !== canvas.height)) {
    const scale = Math.min(canvas.width / size.width, canvas.height / size.height)
    declarations.push(
      `left:50%;top:50%;width:${size.width}px;height:${size.height}px;translate:-50% -50%;scale:${round4(scale)}`,
    )
  }
  const variable = item.variables.find((candidate) => candidate.type === 'font')
  const family = variable === undefined ? undefined : fontOf(clip, variable, catalog)
  if (family !== undefined) {
    const value = `'${family}', '${catalog.cjk.family}', sans-serif`
    declarations.push(`--font-display:${value};--font-body:${value}`)
  }
  return declarations.length === 0
    ? undefined
    : `#${FILM_ID} #${clip.id}{${declarations.join(';')}}`
}

/** 写出成片文件。`durationMs` 是根上写的总时长，默认按片段算。 */
export function writeFilm(
  film: Film,
  catalog: ComponentCatalog,
  durationMs = filmDurationMs(film),
): string {
  const { width, height } = film.canvas
  const variables = filmVariables(film)
  const declared =
    variables.length === 0 ? '' : ` data-composition-variables="${jsonAttribute(variables)}"`
  const body = film.clips.map(writeClip).join('\n')
  const { families, text } = fontsOf(film, catalog)
  // 渲染服务按 <head> 里这种写法的链接找到字体文件
  const fontLinks = families
    .map(
      (family) =>
        `<link rel="stylesheet" href="${escapeAttribute(catalog.fonts[family]?.css ?? '')}">\n`,
    )
    .join('')
  const itemRules = film.clips
    .flatMap((clip) => (clip.kind === 'host' ? (itemRule(clip, film.canvas, catalog) ?? []) : []))
    .map((rule) => `${rule}\n`)
    .join('')
  return `<!doctype html>
<html${declared}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}">
${fontLinks}<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:black;font-family:'${catalog.cjk.family}',sans-serif}
#${FILM_ID}{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:black}
#${FILM_ID} .picture{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
#${FILM_ID} .component{position:absolute;left:0;top:0;width:${width}px;height:${height}px}
${itemRules}</style>
<style>
${cjkFontFaces(catalog, text, families)}
</style>
</head>
<body>
<div id="${FILM_ID}" data-hf-id="${FILM_ID}" data-composition-id="${FILM_ID}" data-no-timeline data-start="0" data-duration="${seconds(durationMs)}" data-width="${width}" data-height="${height}">
${body}
</div>
</body>
</html>
`
}
