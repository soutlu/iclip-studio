import { lintHyperframeHtml } from '@hyperframes/core/lint'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { ComponentCatalog } from '../../web/src/features/storyboard/whole-film/composition/catalog'
import {
  CLIP_SHAPES,
  clipFromAttributes,
  clipKindOfTag,
  FILM_ID,
  filmDurationMs,
  isMediaClip,
  MIN_CLIP_MS,
  sourceVariableId,
  variableValuesOf,
  writeFilm,
  type AttributeRule,
  type ClipAttribute,
  type ClipKind,
  type Film,
  type FilmClip,
} from '../../web/src/features/storyboard/whole-film/composition/film'

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element

export class FilmProblem extends Error {
  /** 给排障看的原文，不答复给调用方。 */
  readonly detail: string | undefined

  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'FilmProblem'
    this.detail = detail
  }
}

/** 成片用到的一条素材：出自哪条记录、文件里写的地址、是视频片段用的视频还是音频片段用的音频。 */
export interface FilmSource {
  jobId: string
  url: string
  kind: 'video' | 'audio'
}

export interface CheckedFilm {
  film: Film
  /** 按写法重新写出来的文件：`<head>`、根上的属性和变量声明都是按片段算出来的。 */
  html: string
  durationMs: number
  sources: FilmSource[]
}

const MAX_URL_CHARS = 2000
const MAX_LABEL_CHARS = 200
const MAX_CANVAS_EDGE = 4096
const MAX_VOLUME = 3.981072
const MIN_PLAYBACK_RATE = 0.1
const MAX_PLAYBACK_RATE = 10
const MAX_TRACK = 99
const MAX_STACKING = 9999
const STACKING_STYLE = /^z-index:\s*(\d+);?$/
const CLIP_ID = /^[a-z][a-z0-9-]{0,63}$/
const SOURCE_VARIABLE = /^src-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DECIMAL = /^\d+(\.\d+)?$/
const INTEGER = /^\d+$/
const CUSTOM_PROPERTY = /^--([^\s:]+)\s*:/

const CLIP_NAMES: Record<ClipKind, string> = {
  video: '视频片段',
  host: '组件或块的片段',
  audio: '音频片段',
}

/** 从片段的 `style` 读叠放顺序：没写是 0；写了叠放顺序之外的样式返回 undefined。 */
function stackingOf(style: string | undefined): number | undefined {
  if (style === undefined || style.trim() === '') return 0
  const z = STACKING_STYLE.exec(style.trim())?.[1]
  return z === undefined ? undefined : Number(z)
}

const isElement = (node: Node): node is Element => 'tagName' in node

const fail = (message: string): never => {
  throw new FilmProblem(message)
}

/** 标签里只能有空白和 `allowed` 这些标签，注释和别的文字都不行。 */
function elementsOf(parent: { childNodes: Node[] }, where: string, allowed: string[]): Element[] {
  const found: Element[] = []
  for (const node of parent.childNodes) {
    if (isElement(node)) {
      if (!allowed.includes(node.tagName)) fail(`${where}中不允许出现 <${node.tagName}>`)
      found.push(node)
    } else if (node.nodeName === '#text') {
      if (node.value.trim() !== '') fail(`${where}中不允许直接写文字`)
    } else {
      fail(`${where}中不允许出现注释`)
    }
  }
  return found
}

function attributes(element: Element, where: string, allowed: readonly string[]) {
  const values = new Map<string, string>()
  for (const { name, value } of element.attrs) {
    if (!allowed.includes(name)) fail(`${where}不允许带 ${name}`)
    values.set(name, value)
  }
  return (name: string): string => values.get(name) ?? fail(`${where}缺少 ${name}`)
}

function milliseconds(value: string, where: string): number {
  if (!DECIMAL.test(value)) fail(`${where}不是秒数：${value}`)
  return Math.round(Number(value) * 1000)
}

function integer(value: string, where: string, max: number): number {
  if (!INTEGER.test(value) || Number(value) > max)
    fail(`${where}必须是 0 到 ${max} 的整数：${value}`)
  return Number(value)
}

function fixed(value: string, expected: string, where: string): void {
  if (value !== expected) fail(`${where}只能是「${expected}」`)
}

type Check = (value: string, where: string) => void

const seconds =
  (name: string): Check =>
  (value, where) =>
    milliseconds(value, `${where}的${name}`)

/** 表里只规定了值的属性在读的时候已经比过，这里不用再查。 */
const FIXED: Check = () => {}

/** 每个属性的值怎么查；表里登记的属性都要在这里有一项，漏了编译不过。 */
const CHECKS: Record<ClipAttribute, Check> = {
  'data-hidden': FIXED,
  class: FIXED,
  'data-has-audio': FIXED,
  muted: FIXED,
  playsinline: FIXED,
  preload: FIXED,
  loop: FIXED,
  id: (value, where) => {
    if (!CLIP_ID.test(value) || value === FILM_ID) fail(`${where}的编号不符合规范`)
  },
  // 和 id 一样，读完整个片段再比
  'data-hf-id': () => {},
  style: (value, where) => {
    const z = stackingOf(value)
    if (z === undefined || z > MAX_STACKING) {
      fail(`${where}的样式只能是 0 到 ${MAX_STACKING} 的叠放顺序`)
    }
  },
  'data-label': (value, where) => {
    if (value.length > MAX_LABEL_CHARS) fail(`${where}的名称超过 ${MAX_LABEL_CHARS} 个字`)
  },
  src: (value, where) => {
    if (value.length > MAX_URL_CHARS || !/^https?:$/.test(URL.parse(value)?.protocol ?? '')) {
      fail(`${where}的地址不是 http(s) 地址`)
    }
  },
  'data-var-src': (value, where) => {
    if (!SOURCE_VARIABLE.test(value)) fail(`${where}绑定的变量不是按记录编号命名的地址变量`)
  },
  'data-start': seconds('起点'),
  'data-duration': seconds('时长'),
  'data-media-start': seconds('入点'),
  'data-playback-start': seconds('组件里的起点'),
  'data-fade-in': seconds('淡入'),
  'data-fade-out': seconds('淡出'),
  'data-track-index': (value, where) => {
    integer(value, `${where}所在的行`, MAX_TRACK)
  },
  'data-volume': (value, where) => {
    if (!DECIMAL.test(value) || Number(value) > MAX_VOLUME) fail(`${where}的音量超出范围`)
  },
  'data-playback-rate': (value, where) => {
    const rate = Number(value)
    if (!DECIMAL.test(value) || rate < MIN_PLAYBACK_RATE || rate > MAX_PLAYBACK_RATE) {
      fail(`${where}的速度必须在 ${MIN_PLAYBACK_RATE} 到 ${MAX_PLAYBACK_RATE} 倍之间`)
    }
  },
  // 和组件库目录比，读完整个片段再查
  'data-composition-id': () => {},
  'data-composition-src': () => {},
  'data-variable-values': (value, where) => {
    if (variableValuesOf(value) === undefined) {
      fail(`${where}的可填项取值必须是 JSON 对象，值为字符串、数字或布尔值`)
    }
  },
}

/** 按表读一个片段：只能带表里这种片段的属性，必须写的都写了，每个值都合规矩。 */
function readClip(element: Element, catalog: ComponentCatalog): FilmClip {
  const kind = clipKindOfTag(element.tagName) ?? fail(`成片的根中不允许出现 <${element.tagName}>`)
  const rules: Readonly<Record<string, AttributeRule>> = CLIP_SHAPES[kind].attributes
  const id = element.attrs.find((attr) => attr.name === 'id')?.value ?? ''
  const where = `${CLIP_NAMES[kind]}「${id}」`
  elementsOf(element, where, [])
  const values: Record<string, string> = {}
  for (const { name, value } of element.attrs) {
    const rule =
      (Object.hasOwn(rules, name) ? rules[name] : undefined) ?? fail(`${where}不允许带 ${name}`)
    if (rule.fixed !== undefined) fixed(value, rule.fixed, `${where}的 ${name}`)
    CHECKS[name as ClipAttribute](value, where)
    values[name] = value
  }
  for (const [name, rule] of Object.entries(rules)) {
    if (!rule.optional && values[name] === undefined) fail(`${where}缺少 ${name}`)
  }
  fixed(values['data-hf-id'] ?? '', id, `${where}的 data-hf-id`)
  if (values['muted'] !== undefined && values['data-has-audio'] !== undefined) {
    fail(`${where}不允许同时带 muted 和 data-has-audio`)
  }
  const clip =
    clipFromAttributes(kind, id, values, String(stackingOf(values['style']))) ??
    fail(`${where}不符合写法`)
  if (clip.duration < MIN_CLIP_MS) fail(`${where}短于 ${MIN_CLIP_MS} 毫秒`)
  if (
    clip.kind === 'host' &&
    !catalog.items.some((item) => item.name === clip.item && item.src === clip.src)
  ) {
    fail(`${where}使用的组件不在组件库中：${clip.item}`)
  }
  return clip
}

/** SDK 声明变量时会在根上写一份同名的 CSS 自定义属性；只认这一种样式，重写时不保留。 */
function checkRootStyle(style: string, declared: ReadonlySet<string>): void {
  for (const declaration of style.split(';')) {
    if (declaration.trim() === '') continue
    const name = CUSTOM_PROPERTY.exec(declaration.trim())?.[1]
    if (name === undefined || !declared.has(name)) fail('根上的样式只能是变量的自定义属性')
  }
}

function checkVariables(json: string | undefined, clips: FilmClip[]): Set<string> {
  let declared: unknown
  try {
    declared = JSON.parse(json ?? '[]')
  } catch {
    return fail('变量声明不是 JSON')
  }
  if (!Array.isArray(declared)) return fail('变量声明必须是数组')
  const expected = new Map(
    clips.filter(isMediaClip).map((clip) => [sourceVariableId(clip.jobId), clip.src]),
  )
  const seen = new Set<string>()
  for (const entry of declared as unknown[]) {
    const { id, type, default: value } = (entry ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || seen.has(id)) return fail('变量声明中有重复或未命名的变量')
    if (!expected.has(id)) fail(`变量「${id}」未被任何片段使用`)
    if (type !== 'string' || value !== expected.get(id)) {
      fail(`变量「${id}」的默认值必须等于片段上的地址`)
    }
    seen.add(id)
  }
  for (const id of expected.keys()) if (!seen.has(id)) fail(`变量「${id}」未声明`)
  return seen
}

/** 编号不重复、同一条记录只有一个地址；同一个区的同一行上片段不能重叠。 */
function checkTimeline(clips: FilmClip[]): void {
  const ids = new Set<string>()
  const sources = new Map<string, string>()
  for (const clip of clips) {
    if (ids.has(clip.id)) fail(`片段的编号重复：${clip.id}`)
    ids.add(clip.id)
    if (isMediaClip(clip)) {
      const known = sources.get(clip.jobId)
      if (known !== undefined && known !== clip.src) {
        fail(`同一条记录写了两个地址：${clip.jobId}`)
      }
      sources.set(clip.jobId, clip.src)
    }
  }
  // 视频片段和组件或块的片段在画面区、音频片段在声音区，两个区的行号各算各的
  const rowOf = (clip: FilmClip) => `${clip.kind === 'audio' ? 'sound' : 'picture'}:${clip.track}`
  const ordered = clips.toSorted((a, b) => rowOf(a).localeCompare(rowOf(b)) || a.start - b.start)
  ordered.forEach((clip, index) => {
    const previous = ordered[index - 1]
    if (
      previous &&
      rowOf(previous) === rowOf(clip) &&
      previous.start + previous.duration > clip.start
    ) {
      fail(`同一行的片段「${previous.id}」和「${clip.id}」在时间上重叠`)
    }
  })
}

const ROOT_ATTRIBUTES = [
  'id',
  'data-hf-id',
  'data-composition-id',
  'data-no-timeline',
  'data-start',
  'data-duration',
  'data-width',
  'data-height',
] as const

/** 按写法读出成片；有任何写法之外的东西、或者组件不在 `catalog` 里，就抛 `FilmProblem`。 */
export function readFilm(html: string, catalog: ComponentCatalog): Film {
  const document = parse(html)
  const page = document.childNodes.filter((node) => node.nodeName !== '#documentType')
  const root = page[0]
  if (page.length !== 1 || !root || !isElement(root) || root.tagName !== 'html') {
    return fail('成片文件必须是完整的 HTML')
  }
  const variables = attributes(root, '<html>', ['data-composition-variables'])
  const [, body] = elementsOf(root, '<html>', ['head', 'body'])
  if (!body || body.tagName !== 'body' || body.attrs.length > 0) {
    return fail('<body> 不允许带属性')
  }
  const [stage, ...others] = elementsOf(body, '<body>', ['div'])
  if (!stage || others.length > 0) return fail('<body> 中只能有成片的根')
  const get = attributes(stage, '成片的根', [...ROOT_ATTRIBUTES, 'style'])
  for (const name of ['id', 'data-hf-id', 'data-composition-id'] as const) {
    fixed(get(name), FILM_ID, `成片的根的 ${name}`)
  }
  fixed(get('data-no-timeline'), '', '成片的根的 data-no-timeline')
  fixed(get('data-start'), '0', '成片的根的 data-start')
  milliseconds(get('data-duration'), '成片的总时长')
  const canvas = {
    width: integer(get('data-width'), '画面的宽', MAX_CANVAS_EDGE),
    height: integer(get('data-height'), '画面的高', MAX_CANVAS_EDGE),
  }
  if (canvas.width === 0 || canvas.height === 0) fail('画面的宽高不允许为 0')
  const tags = Object.values(CLIP_SHAPES).map((shape) => shape.tag)
  const clips = elementsOf(stage, '成片的根', tags).map((element) => readClip(element, catalog))
  checkTimeline(clips)
  const declared = checkVariables(
    root.attrs.some((attr) => attr.name === 'data-composition-variables')
      ? variables('data-composition-variables')
      : undefined,
    clips,
  )
  const style = stage.attrs.find((attr) => attr.name === 'style')?.value
  if (style !== undefined) checkRootStyle(style, declared)
  return { canvas, clips }
}

/** 用到的素材，同一条记录在同一种片段上只算一次。 */
function sourcesOf(film: Film): FilmSource[] {
  const sources = new Map<string, FilmSource>()
  for (const clip of film.clips.filter(isMediaClip)) {
    const kind = clip.kind === 'audio' ? 'audio' : 'video'
    sources.set(`${kind}:${clip.jobId}`, { jobId: clip.jobId, url: clip.src, kind })
  }
  return [...sources.values()]
}

/** 保存和导出前的检查：读出成片、按写法重写、再过一遍渲染引擎自带的检查。 */
export async function checkFilm(html: string, catalog: ComponentCatalog): Promise<CheckedFilm> {
  const film = readFilm(html, catalog)
  const written = writeFilm(film, catalog)
  const { findings } = await lintHyperframeHtml(written, { filePath: 'index.html', host: 'studio' })
  const error = findings.find((finding) => finding.severity === 'error')
  if (error) {
    throw new FilmProblem('成片文件未通过渲染前的检查', `${error.code}: ${error.message}`)
  }
  return { film, html: written, durationMs: filmDurationMs(film), sources: sourcesOf(film) }
}

/**
 * 导出用的那一份：视频片段和音频片段的地址换成下载到本地的路径；隐藏的音频片段不写进去，总时长照旧。
 *
 * 渲染引擎导出时会把页面里的 `<audio>` 再收一遍、按 `data-volume` 混音，不看 `data-hidden`，
 * 隐藏的音频片段留在文件里就会出声。
 */
export function localizedFilm(
  film: Film,
  paths: Readonly<Record<string, string>>,
  catalog: ComponentCatalog,
): string {
  const clips = film.clips.flatMap((clip) => {
    if (clip.kind === 'audio' && clip.hidden) return []
    return [isMediaClip(clip) ? { ...clip, src: paths[clip.src] ?? clip.src } : clip]
  })
  return writeFilm({ ...film, clips }, catalog, filmDurationMs(film))
}
