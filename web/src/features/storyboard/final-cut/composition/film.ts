import type { CatalogItem, ComponentCatalog, VariableValue } from './catalog'
import { cjkFontFaces } from './fonts'
import { escapeAttribute, seconds } from './html'

/**
 * final-cut 工程主文件 `index.html`：工程目录内唯一的主时间线，根节点下每个带时间属性的元素对应时间线上的一个片段。
 * 文件可由编辑器维护亦可手工编辑。编辑器仅修改片段、根节点总时长、画布尺寸与底色及 `<html>` 上声明的字幕变量，
 * `<head>` 中仅重算带标记的字体块（见 `withFontBlock`）与模板画布尺寸（见 `withCanvasSize`），其余内容保持原样。
 */
export interface Canvas {
  width: number
  height: number
}

export type FilmClip = VideoClip | HostClip | AudioClip | OtherClip | CaptionClip
/** 用素材地址的片段：地址写在元素的 `src` 上。 */
export type MediaClip = VideoClip | AudioClip

/**
 * 各种片段共有的部分。时间都是毫秒。
 *
 * `track` 是它在自己那个区的第几行，只管显示：音频片段在声音区，字幕在字幕区，别的在画面区，各区的行号各算各的。
 * `hidden` 的片段留在时间线上、占着它的时间，预览和导出里都不出现、不出声。
 * `link` 是它的链接名（`data-link`）：同名的片段编辑时一起动（「联动」），播放和导出不看它；没有时是 null。
 */
interface ClipBase {
  id: string
  label: string
  start: number
  duration: number
  track: number
  hidden: boolean
  link: string | null
}

/**
 * 视频片段、音频片段共有的声音和播放：`mediaStart` 是从素材的第几毫秒开始放，`volume` 是增益的倍数
 * （0.5 比 1 低 6 dB），`playbackRate` 是速度的倍数（片段在 final-cut 里占的时长不跟着变，用掉的素材是
 * 时长 × 速度），`fadeIn` / `fadeOut` 是声音淡入淡出的毫秒数。
 * `syncOrigin`（`data-sync-origin`）相同的视频片段和音频片段出自同一个文件（分离出来的原声和它的画面），
 * 解除联动后也留着，用来算两段错开了多少；没有时是 null。
 *
 * 智能调音用到的几项，都是属性原样的文字，没写时是 null：`audioGroup` 是 `data-audio-group`（片段属于哪个
 * 声音组，声音角色就是组，见 `audio-role.ts`），`fxCarve` 是 `data-fx-carve`（自动压低的设置，JSON，读法见
 * `carve.ts`，播放和导出不认它），`fxChain` 是 `data-fx-chain`（效果链，JSON；自动压低、自动平稳音量生成的节点
 * 都在里面，预览和导出按它和曲线 `data-automation` 放），`automation` 是 `data-automation`（曲线，JSON；片段音量的
 * 关键帧、压低和平稳音量推效果节点的曲线都在里面，读法见 `volume-envelope.ts`）。
 */
interface MediaBase extends ClipBase {
  src: string
  mediaStart: number
  volume: number
  playbackRate: number
  fadeIn: number
  fadeOut: number
  syncOrigin: string | null
  audioGroup: string | null
  fxCarve: string | null
  fxChain: string | null
  automation: string | null
}

/**
 * 视频片段：`<video>`。`muted` 时不出声。
 *
 * 画面区的片段同时出现时谁盖住谁看 `z`（行内样式里的叠放顺序）：大的在上面，一样大时文件里写在后面的在上面。
 */
export interface VideoClip extends MediaBase {
  kind: 'video'
  muted: boolean
  z: number
}

/**
 * 组件或块的片段：带 `data-composition-src` 的宿主元素，`item` 是它的 `data-composition-id`，按这个名字
 * 在组件库目录里能查到条目。`playbackStart` 是从条目自己的第几毫秒开始播，`values` 是它的可填项取值。
 */
export interface HostClip extends ClipBase {
  kind: 'host'
  item: string
  src: string
  playbackStart: number
  values: Record<string, VariableValue>
  z: number
}

/** 音频片段：`<audio>`。`loop` 时音频比片段短也一直重复着播。隐藏的音频片段不出声。 */
export interface AudioClip extends MediaBase {
  kind: 'audio'
  loop: boolean
  /** 是一句字幕的配音时它是哪种语言、配的哪句（见 `AudioDub`）；别的音频片段是 null。 */
  dub: AudioDub | null
}

/**
 * 配音片段：一句字幕的配音，是一个普通的音频片段，放在「配音」行上、和那句字幕对齐。`caption` 是 `data-dub-of`
 * （它配的那句字幕的编号），写了就是配音片段。`locale` 是 `data-locale`，配的是哪种语言；没写（null）的是这句
 * 在原文下的配音，即旁白，`voice` 是 `data-dub-voice`，记着合成它用的参考音频库里的音色（其它语言给这句配音、
 * 音色取「原声」时用它）。`trimmed` 是 `data-dub-trimmed`，生成时这句加速到上限也放不下、截掉了尾巴。哪种语言下
 * 出不出声见 `voices.ts`。
 */
export interface AudioDub {
  locale: string | null
  caption: string
  trimmed: boolean
  voice: string | null
}

/** 一句字幕的配音片段：带 `data-dub-of` 的音频片段。 */
export const isDubClip = (clip: FilmClip): clip is AudioClip & { dub: AudioDub } =>
  clip.kind === 'audio' && clip.dub !== null

/** 旁白片段：原文下的配音片段（没有 `data-locale`）。 */
export const isNarration = (clip: FilmClip): clip is AudioClip & { dub: AudioDub } =>
  isDubClip(clip) && clip.dub.locale === null

/** 别的带时间的元素（手写的文字、目录里查不到的宿主等）：只能挪动、裁两端、换行、隐藏和删除。 */
export interface OtherClip extends ClipBase {
  kind: 'other'
  z: number
}

/**
 * 一句字幕：字幕场景文件里的一个带时间的元素（见 `captions.ts`），不在主文件里。`text` 是它的字，
 * 存在主文件根上的变量 `variable` 的默认值里。`owner` 是它属于的视频片段（识别出来的字幕跟着这个片段走），
 * 手动加的字幕是 null。`font`、`color`、`fontSize` 是这一句单独设置的字体族、字色和字号（像素）（元素的行内样式，
 * 所有语言共用），没设时是 null，用字幕样式（见 `captions.ts`）。
 */
export interface CaptionClip extends ClipBase {
  kind: 'caption'
  text: string
  variable: string
  owner: string | null
  font: string | null
  color: string | null
  fontSize: number | null
}

export const isMediaClip = (clip: FilmClip): clip is MediaClip =>
  clip.kind === 'video' || clip.kind === 'audio'

/** 从视频片段分离出来的原声：带 `data-sync-origin` 的音频片段。 */
export const isDetachedAudio = (clip: FilmClip): clip is AudioClip =>
  clip.kind === 'audio' && clip.syncOrigin !== null

export const MIN_CLIP_MS = 100

/** 工程主文件在工程目录里的路径。 */
export const PROJECT_MAIN = 'index.html'

/** `<head>` 里字体块的起止标记：保存时只重算这两行之间的内容。 */
export const FONT_BLOCK_START = '<!-- final-cut:fonts -->'
export const FONT_BLOCK_END = '<!-- /final-cut:fonts -->'

/** 编辑器能改的元素属性。 */
export type ClipAttribute =
  | 'data-label'
  | 'data-hidden'
  | 'data-media-start'
  | 'data-playback-start'
  | 'data-volume'
  | 'data-playback-rate'
  | 'data-fade-in'
  | 'data-fade-out'
  | 'data-has-audio'
  | 'muted'
  | 'loop'
  | 'data-variable-values'
  | 'data-link'
  | 'data-sync-origin'
  | 'data-audio-group'

/** 一个元素在读片段时用得到的部分（SDK 的元素快照里有）：`attributes` 不含 `style`、`class`。 */
export interface ElementView {
  id: string
  tag: string
  attributes: Readonly<Record<string, string>>
  /** 行内样式，属性名照 SDK 的写法（`zIndex`）。 */
  inlineStyles: Readonly<Record<string, string>>
  text: string | null
  trackIndex: number | null
}

/** 一个元素在时间线上的起止（秒），来自 SDK 的 `getElementTimings()`。 */
export interface TimingView {
  enterAt: number
  exitAt: number
}

const SECONDS = /^\d+(\.\d+)?$/
const INTEGER = /^\d+$/

const millisecondsOr = (value: string | undefined, fallback: number): number =>
  value !== undefined && SECONDS.test(value) ? Math.round(Number(value) * 1000) : fallback

const numberOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return value === undefined || value.trim() === '' || !Number.isFinite(parsed) ? fallback : parsed
}

/** 链接名这类名字：没写或写成空的都算没有。 */
const nameOf = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value

const stackingOf = (zIndex: string | undefined) =>
  zIndex === undefined || !INTEGER.test(zIndex) ? 0 : Number(zIndex)

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

export const itemNamed = (catalog: ComponentCatalog, name: string): CatalogItem | undefined =>
  catalog.items.find((item) => item.name === name)

/**
 * 把根下面一个带时间的元素读成片段。种类按标签认：`<video>`、`<audio>`、带 `data-composition-src`
 * 且条目在组件库目录里查得到的宿主；别的都是「其他」。属性没写或写得不对时取默认值。
 */
export function clipOf(
  element: ElementView,
  timing: TimingView,
  catalog: ComponentCatalog,
): FilmClip {
  const { attributes } = element
  const start = Math.round(timing.enterAt * 1000)
  const common = {
    id: element.id,
    label: attributes['data-label'] ?? element.text ?? element.tag,
    start,
    duration: Math.round(timing.exitAt * 1000) - start,
    track: element.trackIndex ?? 0,
    hidden: attributes['data-hidden'] !== undefined,
    link: nameOf(attributes['data-link']),
  }
  const z = stackingOf(element.inlineStyles['zIndex'])
  const media = () => ({
    src: attributes['src'] ?? '',
    mediaStart: millisecondsOr(attributes['data-media-start'], 0),
    volume: numberOr(attributes['data-volume'], 1),
    playbackRate: numberOr(attributes['data-playback-rate'], 1),
    fadeIn: millisecondsOr(attributes['data-fade-in'], 0),
    fadeOut: millisecondsOr(attributes['data-fade-out'], 0),
    syncOrigin: nameOf(attributes['data-sync-origin']),
    audioGroup: nameOf(attributes['data-audio-group']),
    fxCarve: nameOf(attributes['data-fx-carve']),
    fxChain: nameOf(attributes['data-fx-chain']),
    automation: nameOf(attributes['data-automation']),
  })
  if (element.tag === 'video')
    return { kind: 'video', ...common, ...media(), muted: attributes['muted'] !== undefined, z }
  if (element.tag === 'audio') {
    const caption = nameOf(attributes['data-dub-of'])
    return {
      kind: 'audio',
      ...common,
      ...media(),
      loop: attributes['loop'] !== undefined,
      dub:
        caption === null
          ? null
          : {
              locale: nameOf(attributes['data-locale']),
              caption,
              trimmed: attributes['data-dub-trimmed'] !== undefined,
              voice: nameOf(attributes['data-dub-voice']),
            },
    }
  }
  const item = attributes['data-composition-id']
  const src = attributes['data-composition-src']
  if (item !== undefined && src !== undefined && itemNamed(catalog, item) !== undefined)
    return {
      kind: 'host',
      ...common,
      item,
      src,
      playbackStart: millisecondsOr(attributes['data-playback-start'], 0),
      values: variableValuesOf(attributes['data-variable-values']) ?? {},
      z,
    }
  return { kind: 'other', ...common, z }
}

/** 要写出的一个元素：属性按给的先后写，值是 undefined 的不写，空串只写属性名。 */
function element(tag: string, attributes: Record<string, string | undefined>): string {
  const written = Object.entries(attributes).flatMap(([name, value]) => {
    if (value === undefined) return []
    return value === '' ? [` ${name}`] : [` ${name}="${escapeAttribute(value)}"`]
  })
  return `<${tag}${written.join('')}></${tag}>`
}

/** 行内样式：属性名照 CSS 的写法，值是 undefined 的不写；一条都没有时是 undefined。 */
const styleText = (declarations: Record<string, string | undefined>): string | undefined => {
  const written = Object.entries(declarations).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}: ${value}`],
  )
  return written.length === 0 ? undefined : written.join('; ')
}

const stacking = (z: number) => (z > 0 ? String(z) : undefined)
const unlessZero = (ms: number) => (ms > 0 ? seconds(ms) : undefined)

const commonAttributes = (clip: ClipBase) => ({
  id: clip.id,
  'data-hf-id': clip.id,
  'data-label': clip.label,
  'data-start': seconds(clip.start),
  'data-duration': seconds(clip.duration),
  'data-track-index': String(clip.track),
  'data-link': clip.link ?? undefined,
})

const mediaAttributes = (clip: MediaBase) => ({
  src: clip.src,
  'data-media-start': seconds(clip.mediaStart),
  'data-volume': String(clip.volume),
  'data-playback-rate': clip.playbackRate === 1 ? undefined : String(clip.playbackRate),
  'data-fade-in': unlessZero(clip.fadeIn),
  'data-fade-out': unlessZero(clip.fadeOut),
  'data-sync-origin': clip.syncOrigin ?? undefined,
  'data-audio-group': clip.audioGroup ?? undefined,
  'data-fx-carve': clip.fxCarve ?? undefined,
  'data-fx-chain': clip.fxChain ?? undefined,
  'data-automation': clip.automation ?? undefined,
})

/** 新加的视频片段：有声音时带 `data-has-audio`，静音时换成 `muted`。 */
export function videoElement(clip: Omit<VideoClip, 'kind'>): string {
  return element('video', {
    'data-hidden': clip.hidden ? '' : undefined,
    style: styleText({ 'z-index': stacking(clip.z) }),
    ...commonAttributes(clip),
    class: 'clip picture',
    ...mediaAttributes(clip),
    'data-has-audio': clip.muted ? undefined : 'true',
    muted: clip.muted ? 'true' : undefined,
    playsinline: '',
    preload: 'auto',
  })
}

/** 新加的音频片段；配音片段带上语言（旁白不带）、配的哪句、截没截尾和旁白的音色。 */
export function audioElement(clip: Omit<AudioClip, 'kind'>): string {
  return element('audio', {
    'data-hidden': clip.hidden ? '' : undefined,
    ...commonAttributes(clip),
    class: 'clip audio',
    ...mediaAttributes(clip),
    loop: clip.loop ? 'true' : undefined,
    'data-locale': clip.dub?.locale ?? undefined,
    'data-dub-of': clip.dub?.caption,
    'data-dub-trimmed': clip.dub?.trimmed === true ? '' : undefined,
    'data-dub-voice': clip.dub?.voice ?? undefined,
  })
}

const round4 = (value: number) => String(Math.round(value * 10_000) / 10_000)

/**
 * 条目在画面里怎么摆：没写尺寸或和画面一样大时铺满（由主文件里 `.component` 的样式管，这里不写）；
 * 写了别的尺寸时按原比例缩到放得下、居中。
 */
export function itemLayout(item: CatalogItem, canvas: Canvas): Record<string, string> {
  const { size } = item
  if (size === null || (size.width === canvas.width && size.height === canvas.height)) return {}
  const scale = Math.min(canvas.width / size.width, canvas.height / size.height)
  return {
    left: '50%',
    top: '50%',
    width: `${size.width}px`,
    height: `${size.height}px`,
    translate: '-50% -50%',
    scale: round4(scale),
  }
}

/**
 * 字体类可填项取到的字体族：片段上填了用填的，没填用默认值。取到的是空的、或者组件库里没有这个字体族时
 * 是 undefined——取值是用户写的字符串，只认组件库里的名字才能写进样式。
 */
function fontOf(
  item: CatalogItem,
  values: Readonly<Record<string, VariableValue>>,
  catalog: ComponentCatalog,
  variableId: string,
): string | undefined {
  const variable = item.variables.find((candidate) => candidate.id === variableId)
  const value = values[variableId] ?? variable?.default
  return typeof value === 'string' && Object.hasOwn(catalog.fonts, value) ? value : undefined
}

/**
 * 条目的字体变量：第一个字体类可填项取到了组件库里的字体时，标题和正文的字体变量都换成它，中文字形退到
 * 组件库的中文字体；取不到时两个变量都是 null（去掉）。写在宿主元素的行内样式上。
 */
export function itemFonts(
  item: CatalogItem,
  values: Readonly<Record<string, VariableValue>>,
  catalog: ComponentCatalog,
): Record<'--font-display' | '--font-body', string | null> {
  const variable = item.variables.find((candidate) => candidate.type === 'font')
  const family = variable === undefined ? undefined : fontOf(item, values, catalog, variable.id)
  const value = family === undefined ? null : `'${family}', '${catalog.cjk.family}', sans-serif`
  return { '--font-display': value, '--font-body': value }
}

/** 新加的组件或块的片段：摆放和字体变量写在行内样式上。 */
export function hostElement(
  clip: Omit<HostClip, 'kind'>,
  item: CatalogItem,
  canvas: Canvas,
  catalog: ComponentCatalog,
): string {
  const fonts = itemFonts(item, clip.values, catalog)
  return element('div', {
    'data-hidden': clip.hidden ? '' : undefined,
    style: styleText({
      'z-index': stacking(clip.z),
      ...itemLayout(item, canvas),
      '--font-display': fonts['--font-display'] ?? undefined,
      '--font-body': fonts['--font-body'] ?? undefined,
    }),
    ...commonAttributes(clip),
    class: 'clip component',
    'data-composition-id': clip.item,
    'data-composition-src': clip.src,
    'data-playback-start': unlessZero(clip.playbackStart),
    'data-variable-values': JSON.stringify(clip.values),
  })
}

/**
 * 工程要声明的字体：用到的条目自带的字体族，加上字体类可填项取到的字体族、字幕样式的字体族（`captionFont`，
 * 见 `captions.ts`）和各句字幕单独设的字体族；中文字体按可填项里的文字、条目里出现的字和字幕的字声明（字幕默认用的
 * 就是中文字体）。组件库里没有的字体族不声明。
 */
function fontsOf(
  clips: readonly FilmClip[],
  catalog: ComponentCatalog,
  captionFont: string | null,
): { families: string[]; text: string } {
  const families = new Set<string>(captionFont === null ? [] : [captionFont])
  let text = ''
  const used = new Set<string>()
  for (const clip of clips) {
    if (clip.kind === 'caption') {
      text += clip.text
      if (clip.font !== null) families.add(clip.font)
    }
    if (clip.kind !== 'host') continue
    text += Object.values(clip.values)
      .filter((value) => typeof value === 'string')
      .join('')
    const item = itemNamed(catalog, clip.item)
    if (item === undefined) continue
    if (!used.has(item.name)) {
      used.add(item.name)
      text += item.chars
      for (const family of item.fonts) families.add(family)
    }
    for (const variable of item.variables) {
      if (variable.type !== 'font') continue
      const family = fontOf(item, clip.values, catalog, variable.id)
      if (family !== undefined) families.add(family)
    }
  }
  return {
    families: [...families].filter((family) => Object.hasOwn(catalog.fonts, family)).sort(),
    text,
  }
}

/**
 * 字体块：两行标记之间是字体族的样式表链接和中文字体的 `@font-face`。`localeText` 是各语言值表里的字，
 * 和片段里的字一起声明，哪种语言预览、导出都有字形；`captionFont` 是字幕样式的字体族（没设时是 null，见 `fontsOf`）。
 */
export function fontBlock(
  clips: readonly FilmClip[],
  catalog: ComponentCatalog,
  localeText = '',
  captionFont: string | null = null,
): string {
  const { families, text } = fontsOf(clips, catalog, captionFont)
  // 渲染服务按这种写法的链接找到字体文件
  const links = families
    .map(
      (family) =>
        `<link rel="stylesheet" href="${escapeAttribute(catalog.fonts[family]?.css ?? '')}">\n`,
    )
    .join('')
  return `${FONT_BLOCK_START}\n${links}<style>\n${cjkFontFaces(catalog, text + localeText, families)}\n</style>\n${FONT_BLOCK_END}`
}

/**
 * 主文件按 `clips`、各语言值表里的字（`localeText`）和字幕样式的字体族（`captionFont`，见 `fontBlock`）换上新的
 * 字体块：只换 `<head>` 里两行标记之间（含标记）的内容，别的一个字不动。`<head>` 里还没有字体块时加在 `</head>`
 * 前面；没有 `</head>` 时原样返回。
 */
export function withFontBlock(
  html: string,
  clips: readonly FilmClip[],
  catalog: ComponentCatalog,
  localeText = '',
  captionFont: string | null = null,
): string {
  const headEnd = html.search(/<\/head\s*>/i)
  if (headEnd < 0) return html
  const block = fontBlock(clips, catalog, localeText, captionFont)
  const from = html.indexOf(FONT_BLOCK_START)
  const to = from < 0 ? -1 : html.indexOf(FONT_BLOCK_END, from)
  if (from < 0 || to < 0 || to > headEnd)
    return `${html.slice(0, headEnd)}${block}\n${html.slice(headEnd)}`
  return `${html.slice(0, from)}${block}${html.slice(to + FONT_BLOCK_END.length)}`
}

export const FILM_ID = 'film'

/** 「新建 final-cut」按默认模板创建工程时的初始画布尺寸（9:16 竖屏）。 */
export const DEFAULT_CANVAS: Canvas = { width: 1080, height: 1920 }

/** 生成 `<head>` 中与画布等大的 viewport 元标签。 */
const viewportOf = ({ width, height }: Canvas) =>
  `<meta name="viewport" content="width=${width}, height=${height}">`

/** 生成铺满画布的尺寸声明（用于 `html,body`、合成根与 `.component` 规则）。 */
const fillingOf = ({ width, height }: Canvas) => `width:${width}px;height:${height}px`

const VIEWPORT = /<meta name="viewport" content="width=\d+, height=\d+">/
const FILLING = new RegExp(
  `(\\n(?:html,body|#${FILM_ID}|#${FILM_ID} \\.component)\\{[^}\\n]*?)width:\\d+px;height:\\d+px`,
  'g',
)

/**
 * 将主文件 `<head>` 中由 `emptyProject` 写入的视口与全画布容器宽高同步为 `canvas`。
 * 画布尺寸以根节点 `data-width` / `data-height` 为准，保存时据此重算；手写或结构不同的 `<head>` 原样保留。
 * 缺少 `</head>` 标签时原样返回。
 */
export function withCanvasSize(html: string, canvas: Canvas): string {
  const headEnd = html.search(/<\/head\s*>/i)
  if (headEnd < 0) return html
  const head = html
    .slice(0, headEnd)
    .replace(VIEWPORT, () => viewportOf(canvas))
    .replace(FILLING, (_, rule: string) => `${rule}${fillingOf(canvas)}`)
  return `${head}${html.slice(headEnd)}`
}

const FILM_BACKGROUND = new RegExp(`\\n#${FILM_ID}\\{[^}\\n]*?background:([^;}\\n]+)`)

/**
 * 提取主文件 `<head>` 中为根节点声明的背景色（`emptyProject` 默认写作 `black`）；未声明或格式不匹配时返回 `null`。
 * 编辑器选择的底色写入根节点行内样式，优先级高于此规则。
 */
export function headBackground(html: string): string | null {
  const headEnd = html.search(/<\/head\s*>/i)
  return FILM_BACKGROUND.exec(headEnd < 0 ? '' : html.slice(0, headEnd))?.[1]?.trim() ?? null
}

/**
 * 生成新建工程的初始主文件 HTML：包含合成根节点属性、动画库脚本、片段基础排版样式及空白字体块占位。
 * `children` 为根节点初始子元素，`durationMs` 为根节点声明总时长。
 */
export function emptyProject(
  canvas: Canvas,
  catalog: ComponentCatalog,
  children = '',
  durationMs = 0,
): string {
  const { width, height } = canvas
  const filling = fillingOf(canvas)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${viewportOf(canvas)}
<script src="${escapeAttribute(catalog.runtime.gsap)}"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{${filling};overflow:hidden;background:black;font-family:'${catalog.cjk.family}',sans-serif}
#${FILM_ID}{position:relative;${filling};overflow:hidden;background:black}
#${FILM_ID} .picture{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
#${FILM_ID} .component{position:absolute;left:0;top:0;${filling}}
</style>
${FONT_BLOCK_START}
${FONT_BLOCK_END}
</head>
<body>
<div id="${FILM_ID}" data-hf-id="${FILM_ID}" data-composition-id="${FILM_ID}" data-no-timeline data-start="0" data-duration="${seconds(durationMs)}" data-width="${width}" data-height="${height}">
${children}</div>
</body>
</html>
`
}
