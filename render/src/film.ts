import { lintHyperframeHtml } from '@hyperframes/core/lint'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { ComponentCatalog } from '../../web/src/features/storyboard/whole-film/composition/catalog'
import {
  BLOCK_SHAPES,
  blockFromAttributes,
  blockKindOfTag,
  FILM_ID,
  filmDurationMs,
  isMediaBlock,
  MAX_FILM_MS,
  MIN_BLOCK_MS,
  sourceVariableId,
  variableValuesOf,
  writeFilm,
  type AttributeRule,
  type BlockAttribute,
  type BlockKind,
  type Film,
  type FilmBlock,
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

/** 成片用到的一条素材：出自哪条记录、文件里写的地址、是画面块用的视频还是音频块用的音频。 */
export interface FilmSource {
  jobId: string
  url: string
  kind: 'video' | 'audio'
}

export interface CheckedFilm {
  film: Film
  /** 按写法重新写出来的文件：`<head>`、根上的属性和变量声明都是按块算出来的。 */
  html: string
  durationMs: number
  sources: FilmSource[]
}

const MAX_URL_CHARS = 2000
const MAX_LABEL_CHARS = 200
const MAX_CANVAS_EDGE = 4096
const MAX_VOLUME = 3.981072
const MAX_TRACK = 99
const MAX_STACKING = 9999
const STACKING_STYLE = /^z-index:\s*(\d+);?$/
const BLOCK_ID = /^[a-z][a-z0-9-]{0,63}$/
const SOURCE_VARIABLE = /^src-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DECIMAL = /^\d+(\.\d+)?$/
const INTEGER = /^\d+$/
const CUSTOM_PROPERTY = /^--([^\s:]+)\s*:/

const BLOCK_NAMES: Record<BlockKind, string> = {
  picture: '画面块',
  component: '组件块',
  audio: '音频块',
}

/** 从块的 `style` 读叠放顺序：没写是 0；写了叠放顺序之外的样式返回 undefined。 */
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
      if (!allowed.includes(node.tagName)) fail(`${where}里不能有 <${node.tagName}>`)
      found.push(node)
    } else if (node.nodeName === '#text') {
      if (node.value.trim() !== '') fail(`${where}里不能直接写文字`)
    } else {
      fail(`${where}里不能有注释`)
    }
  }
  return found
}

function attributes(element: Element, where: string, allowed: readonly string[]) {
  const values = new Map<string, string>()
  for (const { name, value } of element.attrs) {
    if (!allowed.includes(name)) fail(`${where}不能带 ${name}`)
    values.set(name, value)
  }
  return (name: string): string => values.get(name) ?? fail(`${where}缺少 ${name}`)
}

function milliseconds(value: string, where: string): number {
  if (!DECIMAL.test(value)) fail(`${where}不是秒数：${value}`)
  return Math.round(Number(value) * 1000)
}

function integer(value: string, where: string, max: number): number {
  if (!INTEGER.test(value) || Number(value) > max) fail(`${where}要是 0 到 ${max} 的整数：${value}`)
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
const CHECKS: Record<BlockAttribute, Check> = {
  'data-hidden': FIXED,
  class: FIXED,
  'data-has-audio': FIXED,
  playsinline: FIXED,
  preload: FIXED,
  loop: FIXED,
  id: (value, where) => {
    if (!BLOCK_ID.test(value) || value === FILM_ID) fail(`${where}的编号不合规矩`)
  },
  // 和 id 一样，读完整个块再比
  'data-hf-id': () => {},
  style: (value, where) => {
    const z = stackingOf(value)
    if (z === undefined || z > MAX_STACKING) {
      fail(`${where}的样式只能是 0 到 ${MAX_STACKING} 的叠放顺序`)
    }
  },
  'data-label': (value, where) => {
    if (value.length > MAX_LABEL_CHARS) fail(`${where}的名字超过 ${MAX_LABEL_CHARS} 个字`)
  },
  src: (value, where) => {
    if (value.length > MAX_URL_CHARS || !/^https?:$/.test(URL.parse(value)?.protocol ?? '')) {
      fail(`${where}的地址不是 http(s) 地址`)
    }
  },
  'data-var-src': (value, where) => {
    if (!SOURCE_VARIABLE.test(value)) fail(`${where}绑的变量不是按记录编号取名的地址变量`)
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
  // 和组件库目录比，读完整个块再查
  'data-composition-id': () => {},
  'data-composition-src': () => {},
  'data-variable-values': (value, where) => {
    if (variableValuesOf(value) === undefined) {
      fail(`${where}的可填项取值要是一个 JSON 对象，值是字符串、数字或布尔`)
    }
  },
}

/** 按表读一个块：只能带表里这种块的属性，必须写的都写了，每个值都合规矩。 */
function readBlock(element: Element, catalog: ComponentCatalog): FilmBlock {
  const kind = blockKindOfTag(element.tagName) ?? fail(`成片的根里不能有 <${element.tagName}>`)
  const rules: Readonly<Record<string, AttributeRule>> = BLOCK_SHAPES[kind].attributes
  const id = element.attrs.find((attr) => attr.name === 'id')?.value ?? ''
  const where = `${BLOCK_NAMES[kind]}「${id}」`
  elementsOf(element, where, [])
  const values: Record<string, string> = {}
  for (const { name, value } of element.attrs) {
    const rule =
      (Object.hasOwn(rules, name) ? rules[name] : undefined) ?? fail(`${where}不能带 ${name}`)
    if (rule.fixed !== undefined) fixed(value, rule.fixed, `${where}的 ${name}`)
    CHECKS[name as BlockAttribute](value, where)
    values[name] = value
  }
  for (const [name, rule] of Object.entries(rules)) {
    if (!rule.optional && values[name] === undefined) fail(`${where}缺少 ${name}`)
  }
  fixed(values['data-hf-id'] ?? '', id, `${where}的 data-hf-id`)
  const block =
    blockFromAttributes(kind, id, values, String(stackingOf(values['style']))) ??
    fail(`${where}不合写法`)
  if (block.duration < MIN_BLOCK_MS) fail(`${where}短于 ${MIN_BLOCK_MS} 毫秒`)
  if (
    block.kind === 'component' &&
    !catalog.items.some((item) => item.name === block.component && item.src === block.src)
  ) {
    fail(`${where}用的组件不在组件库里：${block.component}`)
  }
  return block
}

/** SDK 声明变量时会在根上写一份同名的 CSS 自定义属性；只认这一种样式，重写时不保留。 */
function checkRootStyle(style: string, declared: ReadonlySet<string>): void {
  for (const declaration of style.split(';')) {
    if (declaration.trim() === '') continue
    const name = CUSTOM_PROPERTY.exec(declaration.trim())?.[1]
    if (name === undefined || !declared.has(name)) fail('根上的样式只能是变量的自定义属性')
  }
}

function checkVariables(json: string | undefined, blocks: FilmBlock[]): Set<string> {
  let declared: unknown
  try {
    declared = JSON.parse(json ?? '[]')
  } catch {
    return fail('变量声明不是 JSON')
  }
  if (!Array.isArray(declared)) return fail('变量声明要是一个数组')
  const expected = new Map(
    blocks.filter(isMediaBlock).map((block) => [sourceVariableId(block.jobId), block.src]),
  )
  const seen = new Set<string>()
  for (const entry of declared as unknown[]) {
    const { id, type, default: value } = (entry ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || seen.has(id)) return fail('变量声明里有重复或没有名字的变量')
    if (!expected.has(id)) fail(`变量「${id}」没有块在用`)
    if (type !== 'string' || value !== expected.get(id)) {
      fail(`变量「${id}」的默认值要等于块上写的地址`)
    }
    seen.add(id)
  }
  for (const id of expected.keys()) if (!seen.has(id)) fail(`变量「${id}」没有声明`)
  return seen
}

/** 编号不重复、同一条记录只有一个地址、画面块不超过总长上限；同一个区的同一行上块不能重叠。 */
function checkTimeline(blocks: FilmBlock[]): void {
  const ids = new Set<string>()
  const sources = new Map<string, string>()
  for (const block of blocks) {
    if (ids.has(block.id)) fail(`块的编号重复：${block.id}`)
    ids.add(block.id)
    if (isMediaBlock(block)) {
      const known = sources.get(block.jobId)
      if (known !== undefined && known !== block.src) {
        fail(`同一条记录写了两个地址：${block.jobId}`)
      }
      sources.set(block.jobId, block.src)
    }
    if (block.kind === 'picture' && block.start + block.duration > MAX_FILM_MS) {
      fail(`成片超过了 ${MAX_FILM_MS / 1000} 秒的上限`)
    }
  }
  // 画面块和组件块在画面区、音频块在声音区，两个区的行号各算各的
  const rowOf = (block: FilmBlock) =>
    `${block.kind === 'audio' ? 'sound' : 'picture'}:${block.track}`
  const ordered = blocks.toSorted((a, b) => rowOf(a).localeCompare(rowOf(b)) || a.start - b.start)
  ordered.forEach((block, index) => {
    const previous = ordered[index - 1]
    if (
      previous &&
      rowOf(previous) === rowOf(block) &&
      previous.start + previous.duration > block.start
    ) {
      fail(`同一行的块「${previous.id}」和「${block.id}」在时间上重叠`)
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
    return fail('成片文件要是一份完整的 HTML')
  }
  const variables = attributes(root, '<html>', ['data-composition-variables'])
  const [, body] = elementsOf(root, '<html>', ['head', 'body'])
  if (!body || body.tagName !== 'body' || body.attrs.length > 0) {
    return fail('<body> 不能带属性')
  }
  const [stage, ...others] = elementsOf(body, '<body>', ['div'])
  if (!stage || others.length > 0) return fail('<body> 里只能有成片的根')
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
  if (canvas.width === 0 || canvas.height === 0) fail('画面的宽高不能是 0')
  const tags = Object.values(BLOCK_SHAPES).map((shape) => shape.tag)
  const blocks = elementsOf(stage, '成片的根', tags).map((element) => readBlock(element, catalog))
  checkTimeline(blocks)
  const declared = checkVariables(
    root.attrs.some((attr) => attr.name === 'data-composition-variables')
      ? variables('data-composition-variables')
      : undefined,
    blocks,
  )
  const style = stage.attrs.find((attr) => attr.name === 'style')?.value
  if (style !== undefined) checkRootStyle(style, declared)
  return { canvas, blocks }
}

/** 用到的素材，同一条记录在同一种块上只算一次。 */
function sourcesOf(film: Film): FilmSource[] {
  const sources = new Map<string, FilmSource>()
  for (const block of film.blocks.filter(isMediaBlock)) {
    const kind = block.kind === 'audio' ? 'audio' : 'video'
    sources.set(`${kind}:${block.jobId}`, { jobId: block.jobId, url: block.src, kind })
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
    throw new FilmProblem('成片文件没通过渲染前的检查', `${error.code}: ${error.message}`)
  }
  return { film, html: written, durationMs: filmDurationMs(film), sources: sourcesOf(film) }
}

/**
 * 导出用的那一份：画面块和音频块的地址换成下载到本地的路径；隐藏的音频块不写进去，总时长照旧。
 *
 * 渲染引擎导出时会把页面里的 `<audio>` 再收一遍、按 `data-volume` 混音，不看 `data-hidden`，
 * 隐藏的音频块留在文件里就会出声。
 */
export function localizedFilm(
  film: Film,
  paths: Readonly<Record<string, string>>,
  catalog: ComponentCatalog,
): string {
  const blocks = film.blocks.flatMap((block) => {
    if (block.kind === 'audio' && block.hidden) return []
    return [isMediaBlock(block) ? { ...block, src: paths[block.src] ?? block.src } : block]
  })
  return writeFilm({ ...film, blocks }, catalog, filmDurationMs(film))
}
