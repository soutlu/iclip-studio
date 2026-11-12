import { lintHyperframeHtml } from '@hyperframes/core/lint'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { ComponentCatalog } from '../../web/src/features/storyboard/whole-film/composition/catalog'
import {
  FILM_ID,
  filmDurationMs,
  MAX_FILM_MS,
  MIN_BLOCK_MS,
  PICTURE_CLASS,
  sourceVariableId,
  writeFilm,
  type Film,
  type PictureBlock,
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

export interface FilmSource {
  jobId: string
  url: string
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

/** 从块的 `style` 读叠放顺序：没写是 0；写了叠放顺序之外的样式返回 undefined。 */
function stackingOf(style: string | undefined): number | undefined {
  if (style === undefined || style.trim() === '') return 0
  const z = STACKING_STYLE.exec(style.trim())?.[1]
  return z === undefined ? undefined : Number(z)
}
const BLOCK_ID = /^[a-z][a-z0-9-]{0,63}$/
const SOURCE_VARIABLE = /^src-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const DECIMAL = /^\d+(\.\d+)?$/
const INTEGER = /^\d+$/
const CUSTOM_PROPERTY = /^--([^\s:]+)\s*:/

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

const PICTURE_ATTRIBUTES = [
  'id',
  'data-hf-id',
  'class',
  'data-label',
  'src',
  'data-var-src',
  'data-start',
  'data-duration',
  'data-media-start',
  'data-track-index',
  'data-volume',
  'data-has-audio',
  'playsinline',
  'preload',
] as const

function readPicture(element: Element): PictureBlock {
  const id = element.attrs.find((attr) => attr.name === 'id')?.value ?? ''
  if (!BLOCK_ID.test(id) || id === FILM_ID) fail(`画面块的编号不合规矩：${id}`)
  const where = `画面块「${id}」`
  const get = attributes(element, where, [...PICTURE_ATTRIBUTES, 'style'])
  elementsOf(element, where, [])
  // 块上的样式只认叠放顺序这一种，没写就是 0
  const z = stackingOf(element.attrs.find((attr) => attr.name === 'style')?.value)
  if (z === undefined || z > MAX_STACKING) {
    fail(`${where}的样式只能是 0 到 ${MAX_STACKING} 的叠放顺序`)
  }
  fixed(get('data-hf-id'), id, `${where}的 data-hf-id`)
  fixed(get('class'), PICTURE_CLASS, `${where}的 class`)
  fixed(get('data-has-audio'), 'true', `${where}的 data-has-audio`)
  fixed(get('playsinline'), '', `${where}的 playsinline`)
  fixed(get('preload'), 'auto', `${where}的 preload`)
  const label = get('data-label')
  if (label.length > MAX_LABEL_CHARS) fail(`${where}的名字超过 ${MAX_LABEL_CHARS} 个字`)
  const src = get('src')
  if (src.length > MAX_URL_CHARS || !/^https?:$/.test(URL.parse(src)?.protocol ?? '')) {
    fail(`${where}的地址不是 http(s) 地址`)
  }
  const jobId = SOURCE_VARIABLE.exec(get('data-var-src'))?.[1]
  if (jobId === undefined) fail(`${where}绑的变量不是素材片的地址变量`)
  const duration = milliseconds(get('data-duration'), `${where}的时长`)
  if (duration < MIN_BLOCK_MS) fail(`${where}短于 ${MIN_BLOCK_MS} 毫秒`)
  const volume = get('data-volume')
  if (!DECIMAL.test(volume) || Number(volume) > MAX_VOLUME) fail(`${where}的音量超出范围`)
  return {
    id,
    label,
    jobId: jobId as string,
    src,
    start: milliseconds(get('data-start'), `${where}的起点`),
    duration,
    mediaStart: milliseconds(get('data-media-start'), `${where}的入点`),
    track: integer(get('data-track-index'), `${where}所在的行`, MAX_TRACK),
    volume: Number(volume),
    z: z as number,
  }
}

/** SDK 声明变量时会在根上写一份同名的 CSS 自定义属性；只认这一种样式，重写时不保留。 */
function checkRootStyle(style: string, declared: ReadonlySet<string>): void {
  for (const declaration of style.split(';')) {
    if (declaration.trim() === '') continue
    const name = CUSTOM_PROPERTY.exec(declaration.trim())?.[1]
    if (name === undefined || !declared.has(name)) fail('根上的样式只能是变量的自定义属性')
  }
}

function checkVariables(json: string | undefined, blocks: PictureBlock[]): Set<string> {
  let declared: unknown
  try {
    declared = JSON.parse(json ?? '[]')
  } catch {
    return fail('变量声明不是 JSON')
  }
  if (!Array.isArray(declared)) return fail('变量声明要是一个数组')
  const expected = new Map(blocks.map((block) => [sourceVariableId(block.jobId), block.src]))
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

function checkTimeline(blocks: PictureBlock[]): void {
  const ids = new Set<string>()
  const sources = new Map<string, string>()
  for (const block of blocks) {
    if (ids.has(block.id)) fail(`块的编号重复：${block.id}`)
    ids.add(block.id)
    const known = sources.get(block.jobId)
    if (known !== undefined && known !== block.src) fail(`同一条素材片写了两个地址：${block.jobId}`)
    sources.set(block.jobId, block.src)
    if (block.start + block.duration > MAX_FILM_MS) {
      fail(`成片超过了 ${MAX_FILM_MS / 1000} 秒的上限`)
    }
  }
  const ordered = blocks.toSorted((a, b) => a.track - b.track || a.start - b.start)
  ordered.forEach((block, index) => {
    const previous = ordered[index - 1]
    if (
      previous &&
      previous.track === block.track &&
      previous.start + previous.duration > block.start
    ) {
      fail(`同一行的块「${previous.id}」和「${block.id}」在时间上重叠`)
    }
  })
}

/** 按写法读出成片；有任何写法之外的东西就抛 `FilmProblem`。 */
export function readFilm(html: string): Film {
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
  const blocks = elementsOf(stage, '成片的根', ['video']).map(readPicture)
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

/** 保存和导出前的检查：读出成片、按写法重写、再过一遍渲染引擎自带的检查。 */
export async function checkFilm(html: string, catalog: ComponentCatalog): Promise<CheckedFilm> {
  const film = readFilm(html)
  const written = writeFilm(film, catalog)
  const { findings } = await lintHyperframeHtml(written, { filePath: 'index.html', host: 'studio' })
  const error = findings.find((finding) => finding.severity === 'error')
  if (error) {
    throw new FilmProblem('成片文件没通过渲染前的检查', `${error.code}: ${error.message}`)
  }
  const sources = new Map(film.blocks.map((block) => [block.jobId, block.src]))
  return {
    film,
    html: written,
    durationMs: filmDurationMs(film),
    sources: [...sources].map(([jobId, url]) => ({ jobId, url })),
  }
}

/** 导出用的那一份：素材地址换成下载到本地的路径，别的不变。 */
export function localizedFilm(
  film: Film,
  paths: Readonly<Record<string, string>>,
  catalog: ComponentCatalog,
): string {
  const blocks = film.blocks.map((block) => ({ ...block, src: paths[block.src] ?? block.src }))
  return writeFilm({ ...film, blocks }, catalog)
}
