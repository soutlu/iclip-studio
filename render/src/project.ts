import { parse, type DefaultTreeAdapterTypes } from 'parse5'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

/** final-cut 工程中的单个文本文件，路径相对工程根目录。 */
export interface ProjectFile {
  path: string
  content: string
}

/** 工程的主文件：唯一的主时间线。 */
export const MAIN_FILE = 'index.html'

/** 工程中的 `vendor/` 为渲染服务注入的公共依赖目录，工程自身不得包含同名路径。 */
export const VENDOR_DIR = 'vendor'

const CONTROL = /\p{Cc}/u

/**
 * 校验工程文件路径并返回错误说明，合规时返回 undefined。规则与后端读取工程文件一致：
 * 使用 `/` 分隔的相对路径，禁止空段、`.`、`..`、首尾 `/`、反斜杠及控制字符，且首段不得为 `vendor`。
 */
export function projectPathProblem(path: string): string | undefined {
  if (path === '' || path.includes('\\') || CONTROL.test(path)) return '路径不合规'
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return '路径不合规'
  if (segments[0]?.toLowerCase() === VENDOR_DIR) return '路径不能以 vendor/ 开头'
  return undefined
}

/**
 * 校验整组工程文件并返回错误说明，合规时返回 undefined。要求所有路径合规且不重复，
 * 同一路径不得既作为文件又作为其他文件的父目录，且须包含主文件。
 */
export function projectProblem(files: readonly ProjectFile[]): string | undefined {
  // 比较时不分大小写：工程写入的临时目录可能位于大小写不敏感的文件系统
  const seen = new Set<string>()
  for (const { path } of files) {
    const problem = projectPathProblem(path)
    if (problem !== undefined) return `工程文件「${path}」${problem}`
    const key = path.toLowerCase()
    if (seen.has(key)) return `工程文件「${path}」重复`
    seen.add(key)
  }
  for (const { path } of files) {
    const segments = path.toLowerCase().split('/')
    for (let end = 1; end < segments.length; end += 1) {
      if (seen.has(segments.slice(0, end).join('/')))
        return `工程文件「${segments.slice(0, end).join('/')}」同时是「${path}」所在的目录`
    }
  }
  if (!files.some((file) => file.path === MAIN_FILE)) return `工程缺少主文件 ${MAIN_FILE}`
  return undefined
}

const isElement = (node: Node): node is Element => 'tagName' in node

/** `node` 下的全部元素（含 `<template>` 内部），按文档出现顺序排列。 */
export function* elementsOf(node: Node): Generator<Element> {
  if (isElement(node)) yield node
  const children = 'childNodes' in node ? node.childNodes : []
  for (const child of children) yield* elementsOf(child)
  if (isElement(node) && 'content' in node) yield* elementsOf(node.content)
}

/** 查找 `node` 下的合成根元素（首个携带 `data-composition-id` 属性的元素）。 */
export const compositionRootOf = (node: Node): Element | undefined =>
  [...elementsOf(node)].find((element) =>
    element.attrs.some((attr) => attr.name === 'data-composition-id'),
  )

function* mediaElements(node: Node): Generator<Element> {
  for (const element of elementsOf(node))
    if (element.tagName === 'video' || element.tagName === 'audio') yield element
}

/** 提取主文件中 `<video>` 与 `<audio>` 元素的 `src` 素材地址并去重。 */
export function mediaAddresses(html: string): string[] {
  const addresses = new Set<string>()
  for (const element of mediaElements(parse(html))) {
    const src = element.attrs.find((attr) => attr.name === 'src')?.value
    if (src !== undefined) addresses.add(src)
  }
  return [...addresses]
}

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

/** 序列化单个 HTML 属性（`name="value"`），转义属性值中的 `&` 与 `"`。 */
export const attributeText = (name: string, value: string) => `${name}="${escapeAttribute(value)}"`

/** 对 `html` 源码的单处编辑：将区间 `[from, to)` 替换为 `text`（`from === to` 表示插入）。 */
export interface SourceEdit {
  from: number
  to: number
  text: string
}

/** 按源码偏移应用互不重叠的 `edits`，其余内容保持原样。 */
export function applyEdits(html: string, edits: readonly SourceEdit[]): string {
  let edited = html
  for (const { from, to, text } of edits.toSorted((a, b) => b.from - a.from))
    edited = `${edited.slice(0, from)}${text}${edited.slice(to)}`
  return edited
}

/**
 * 生成导出用主文件：按 `paths`（源码中声明的地址 → 本地相对路径）替换 `<video>` 与 `<audio>` 的 `src` 属性，
 * 其余内容保持原样。
 */
export function withLocalMedia(html: string, paths: ReadonlyMap<string, string>): string {
  const edits: SourceEdit[] = []
  for (const element of mediaElements(parse(html, { sourceCodeLocationInfo: true }))) {
    const src = element.attrs.find((attr) => attr.name === 'src')?.value
    const local = src === undefined ? undefined : paths.get(src)
    const at = element.sourceCodeLocation?.attrs?.['src']
    if (local === undefined || at === undefined) continue
    edits.push({ from: at.startOffset, to: at.endOffset, text: attributeText('src', local) })
  }
  return applyEdits(html, edits)
}
