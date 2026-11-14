import type { CatalogItem, CatalogVariable, ComponentCatalog, VariableValue } from './catalog'
import { cjkFontFaces } from './fonts'
import { escapeAttribute, jsonAttribute, seconds } from './html'

/**
 * 成片文件：一份 HTML，时间线上每个块是根下面的一个标签。
 *
 * 文件不带脚本（根上标 `data-no-timeline`）。`<head>`、根上的属性和 `<html>` 上的变量声明都由
 * 这里按块算出来，不单独保存。
 */
export interface Film {
  canvas: Canvas
  blocks: FilmBlock[]
}

export interface Canvas {
  width: number
  height: number
}

export type FilmBlock = PictureBlock | ComponentBlock | AudioBlock
export type BlockKind = FilmBlock['kind']
/** 用素材地址的块：地址写在块上，并绑到按记录编号取名的变量。 */
export type MediaBlock = PictureBlock | AudioBlock

/**
 * 三种块共有的部分。时间都是毫秒。
 *
 * `track` 是它在自己那个区的第几行，只管显示：画面块和组件块在画面区，音频块在声音区，
 * 两个区的行号各算各的。
 * `hidden` 的块留在时间线上、占着它的时间，预览和导出里都不出现、不出声；没隐藏时文件里不写。
 */
interface BlockBase {
  id: string
  label: string
  start: number
  duration: number
  track: number
  hidden: boolean
}

/**
 * 画面块、音频块共有的声音和播放：`mediaStart` 是从素材的第几毫秒开始放，`volume` 是增益的倍数
 * （0.5 比 1 低 6 dB），`playbackRate` 是速度的倍数（块在成片里占的时长不跟着变，用掉的素材是
 * 时长 × 速度），`fadeIn` / `fadeOut` 是声音淡入淡出的毫秒数。速度是 1、淡入淡出是 0 时文件里不写。
 */
interface MediaBase extends BlockBase {
  jobId: string
  src: string
  mediaStart: number
  volume: number
  playbackRate: number
  fadeIn: number
  fadeOut: number
}

/**
 * 画面块：一段素材片，`src` 是素材片记录上的地址。`muted` 时不出声。
 *
 * 两个画面区的块同时出现时谁盖住谁看 `z`（叠放顺序）：大的在上面，一样大时文件里写在后面的在上面。
 * `z` 是 0 时文件里不写。
 */
export interface PictureBlock extends MediaBase {
  kind: 'picture'
  muted: boolean
  z: number
}

/**
 * 组件块：组件库里的一个条目。`component` 是条目的名字，`src` 是条目的文件。
 * 条目没写尺寸或和画面一样大时铺满画面；写了别的尺寸时按原比例缩到放得下、居中（写在 `<head>` 里）。
 * `playbackStart` 是从组件自己的第几毫秒开始播，`values` 是它的可填项取值；叠放顺序同画面块。
 * `playbackStart` 是 0 时文件里不写。
 */
export interface ComponentBlock extends BlockBase {
  kind: 'component'
  component: string
  src: string
  playbackStart: number
  values: Record<string, VariableValue>
  z: number
}

/**
 * 音频块：一条音频记录，`src` 是记录上的地址。`loop` 时音频比块短也一直重复着播，不循环时文件里不写。
 * 隐藏的音频块不出声。
 */
export interface AudioBlock extends MediaBase {
  kind: 'audio'
  loop: boolean
}

export const isMediaBlock = (block: FilmBlock): block is MediaBlock => block.kind !== 'component'

export interface FilmVariable {
  id: string
  type: 'string'
  label: string
  default: string
}

export const FILM_ID = 'film'
export const MIN_BLOCK_MS = 100
export const SOURCE_LABEL = '素材片'
export const AUDIO_SOURCE_LABEL = '音频'

/**
 * 块上的一个属性。默认是必须写的；`optional` 的取默认值时不写；`fixed` 的只能是这个值
 * （可选又固定的，写就是写这个值）。
 */
export interface AttributeRule {
  optional?: true
  fixed?: string
}

const REQUIRED: AttributeRule = {}
const OPTIONAL: AttributeRule = { optional: true }
// 隐藏标记和叠放顺序（块上唯一能带的样式）写在最前面，和 SDK 存出来的一样
const HIDDEN: AttributeRule = { optional: true, fixed: '' }

/**
 * 三种块的写法：标签和能带的属性（按写出的先后）。写出、读回和渲染服务的检查都按这张表。
 */
export const BLOCK_SHAPES = {
  picture: {
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
  component: {
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
  BlockKind,
  { tag: string; attributes: Readonly<Record<string, AttributeRule>> }
>

export type BlockAttribute = {
  [Kind in BlockKind]: keyof (typeof BLOCK_SHAPES)[Kind]['attributes']
}[BlockKind]

/** 一个块要写的属性值；可选属性是 undefined 时不写。 */
type Attributes = Partial<Record<BlockAttribute, string | undefined>>

/** 按标签认块：成片的根下面每种标签只对应一种块。 */
export function blockKindOfTag(tag: string): BlockKind | undefined {
  const kinds = Object.keys(BLOCK_SHAPES) as BlockKind[]
  return kinds.find((kind) => BLOCK_SHAPES[kind].tag === tag)
}

export const sourceVariableId = (jobId: string): string => `src-${jobId}`

/** 素材地址的变量：一条记录一个，默认值就是块上写的地址。 */
export function sourceVariable(jobId: string, src: string, label = SOURCE_LABEL): FilmVariable {
  return { id: sourceVariableId(jobId), type: 'string', label, default: src }
}

export function filmDurationMs(film: Film): number {
  return Math.max(0, ...film.blocks.map((block) => block.start + block.duration))
}

export function filmVariables(film: Film): FilmVariable[] {
  const bySource = new Map(
    film.blocks
      .filter(isMediaBlock)
      .map((block) => [
        block.jobId,
        sourceVariable(
          block.jobId,
          block.src,
          block.kind === 'audio' ? AUDIO_SOURCE_LABEL : SOURCE_LABEL,
        ),
      ]),
  )
  return [...bySource.values()]
}

/** 按表里的先后写出一个块；可选属性没给值就不写，固定的空值只写属性名。 */
function blockElement(kind: BlockKind, values: Attributes): string {
  const { tag, attributes } = BLOCK_SHAPES[kind]
  const written = Object.entries(attributes).flatMap(([name, rule]: [string, AttributeRule]) => {
    const given = values[name as BlockAttribute]
    const value = rule.optional ? given : (rule.fixed ?? given)
    if (value === undefined) return []
    if (value === '' && rule.fixed === '' && !rule.optional) return [` ${name}`]
    return [` ${name}="${escapeAttribute(value)}"`]
  })
  return `<${tag}${written.join('')}></${tag}>`
}

const commonValues = (block: FilmBlock): Attributes => ({
  'data-hidden': block.hidden ? '' : undefined,
  id: block.id,
  'data-hf-id': block.id,
  'data-label': block.label,
  'data-start': seconds(block.start),
  'data-duration': seconds(block.duration),
  'data-track-index': String(block.track),
})

const stacking = (z: number) => (z > 0 ? `z-index: ${z}` : undefined)
const unlessZero = (ms: number) => (ms > 0 ? seconds(ms) : undefined)

const mediaValues = (block: MediaBlock): Attributes => ({
  src: block.src,
  'data-var-src': sourceVariableId(block.jobId),
  'data-media-start': seconds(block.mediaStart),
  'data-volume': String(block.volume),
  'data-playback-rate': block.playbackRate === 1 ? undefined : String(block.playbackRate),
  'data-fade-in': unlessZero(block.fadeIn),
  'data-fade-out': unlessZero(block.fadeOut),
})

export function pictureBlock(block: PictureBlock): string {
  return blockElement('picture', {
    ...commonValues(block),
    style: stacking(block.z),
    ...mediaValues(block),
    'data-has-audio': block.muted ? undefined : 'true',
    muted: block.muted ? 'true' : undefined,
  })
}

export function componentBlock(block: ComponentBlock): string {
  return blockElement('component', {
    ...commonValues(block),
    style: stacking(block.z),
    'data-composition-id': block.component,
    'data-composition-src': block.src,
    'data-playback-start': unlessZero(block.playbackStart),
    'data-variable-values': JSON.stringify(block.values),
  })
}

export function audioBlock(block: AudioBlock): string {
  return blockElement('audio', {
    ...commonValues(block),
    ...mediaValues(block),
    loop: block.loop ? 'true' : undefined,
  })
}

export function writeBlock(block: FilmBlock): string {
  switch (block.kind) {
    case 'picture':
      return pictureBlock(block)
    case 'component':
      return componentBlock(block)
    case 'audio':
      return audioBlock(block)
  }
}

const SECONDS = /^\d+(\.\d+)?$/
const INTEGER = /^\d+$/

type AttributeSource = Readonly<Record<string, string>>

const millisecondsOf = (value: string | undefined): number | undefined =>
  value !== undefined && SECONDS.test(value) ? Math.round(Number(value) * 1000) : undefined

/** 三种块共有的部分；起点、时长没写或不是秒数时返回 undefined。 */
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

/** 素材块的地址、入点和声音、播放；没写全时返回 undefined。 */
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
 * 从块的属性读回画面块；不是 `pictureBlock` 写出来的那种块时返回 undefined。
 * `zIndex` 是块的行内样式里的叠放顺序（SDK 的元素快照把样式和属性分开给）。
 */
export function pictureFromAttributes(
  id: string,
  attributes: AttributeSource,
  zIndex?: string,
): PictureBlock | undefined {
  const common = commonOf(id, attributes)
  const media = mediaOf(attributes)
  if (common === undefined || media === undefined) return undefined
  return {
    kind: 'picture',
    ...common,
    ...media,
    muted: attributes['muted'] !== undefined,
    z: stackingOf(zIndex),
  }
}

/** 从块的属性读回组件块；不是 `componentBlock` 写出来的那种块时返回 undefined。`zIndex` 同画面块。 */
export function componentFromAttributes(
  id: string,
  attributes: AttributeSource,
  zIndex?: string,
): ComponentBlock | undefined {
  const common = commonOf(id, attributes)
  const component = attributes['data-composition-id']
  const src = attributes['data-composition-src']
  const playbackStart = millisecondsOf(attributes['data-playback-start'] ?? '0')
  const values = variableValuesOf(attributes['data-variable-values'])
  if (
    common === undefined ||
    component === undefined ||
    src === undefined ||
    playbackStart === undefined ||
    values === undefined
  )
    return undefined
  return {
    kind: 'component',
    ...common,
    component,
    src,
    playbackStart,
    values,
    z: stackingOf(zIndex),
  }
}

/** 从块的属性读回音频块；不是 `audioBlock` 写出来的那种块时返回 undefined。 */
export function audioFromAttributes(
  id: string,
  attributes: AttributeSource,
): AudioBlock | undefined {
  const common = commonOf(id, attributes)
  const media = mediaOf(attributes)
  if (common === undefined || media === undefined) return undefined
  return { kind: 'audio', ...common, ...media, loop: attributes['loop'] !== undefined }
}

export function blockFromAttributes(
  kind: BlockKind,
  id: string,
  attributes: AttributeSource,
  zIndex?: string,
): FilmBlock | undefined {
  switch (kind) {
    case 'picture':
      return pictureFromAttributes(id, attributes, zIndex)
    case 'component':
      return componentFromAttributes(id, attributes, zIndex)
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

const itemOf = (block: ComponentBlock, catalog: ComponentCatalog): CatalogItem | undefined =>
  catalog.items.find((candidate) => candidate.name === block.component)

/**
 * 字体类可填项取到的字体族：块上填了用填的，没填用默认值。取到的是空的、或者组件库里没有这个字体族时
 * 是 undefined——取值是用户写的字符串，只认组件库里的名字才能写进样式。
 */
function fontOf(
  block: ComponentBlock,
  variable: CatalogVariable,
  catalog: ComponentCatalog,
): string | undefined {
  const value = block.values[variable.id] ?? variable.default
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
  for (const block of film.blocks) {
    if (block.kind !== 'component') continue
    text += Object.values(block.values)
      .filter((value) => typeof value === 'string')
      .join('')
    const item = itemOf(block, catalog)
    if (item === undefined) continue
    if (!used.has(item.name)) {
      used.add(item.name)
      text += item.chars
      for (const family of item.fonts) families.add(family)
    }
    for (const variable of item.variables) {
      if (variable.type !== 'font') continue
      const family = fontOf(block, variable, catalog)
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
 * 一个组件块在 `<head>` 里的规则；不用写时返回 undefined。块上的样式只能是叠放顺序，所以写在这里、按块的编号认。
 * - 条目有尺寸、和画面不一样大：按原比例缩到放得下，居中。
 * - 第一个字体类可填项取到了字体：标题和正文的字体变量都换成它，中文字形退到组件库的中文字体。
 */
function componentRule(
  block: ComponentBlock,
  canvas: Canvas,
  catalog: ComponentCatalog,
): string | undefined {
  const item = itemOf(block, catalog)
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
  const family = variable === undefined ? undefined : fontOf(block, variable, catalog)
  if (family !== undefined) {
    const value = `'${family}', '${catalog.cjk.family}', sans-serif`
    declarations.push(`--font-display:${value};--font-body:${value}`)
  }
  return declarations.length === 0
    ? undefined
    : `#${FILM_ID} #${block.id}{${declarations.join(';')}}`
}

/** 写出成片文件。`durationMs` 是根上写的总时长，默认按块算。 */
export function writeFilm(
  film: Film,
  catalog: ComponentCatalog,
  durationMs = filmDurationMs(film),
): string {
  const { width, height } = film.canvas
  const variables = filmVariables(film)
  const declared =
    variables.length === 0 ? '' : ` data-composition-variables="${jsonAttribute(variables)}"`
  const body = film.blocks.map(writeBlock).join('\n')
  const { families, text } = fontsOf(film, catalog)
  // 渲染服务按 <head> 里这种写法的链接找到字体文件
  const fontLinks = families
    .map(
      (family) =>
        `<link rel="stylesheet" href="${escapeAttribute(catalog.fonts[family]?.css ?? '')}">\n`,
    )
    .join('')
  const componentRules = film.blocks
    .flatMap((block) =>
      block.kind === 'component' ? (componentRule(block, film.canvas, catalog) ?? []) : [],
    )
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
${componentRules}</style>
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
