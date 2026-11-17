import { parse, type DefaultTreeAdapterTypes } from 'parse5'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

/** final-cut 工程的一个文件：路径相对工程根，内容是文本。 */
export interface ProjectFile {
  path: string
  content: string
}

/** 工程的主文件：唯一的主时间线。 */
export const MAIN_FILE = 'index.html'

/** 工程里 `vendor/` 指向公共目录，由渲染服务放上，工程自己不能有这个名字的文件。 */
export const VENDOR_DIR = 'vendor'

const CONTROL = /\p{Cc}/u

/**
 * 工程文件的路径哪里不合规；合规时是 undefined。规则和后端取工程文件的规则一样：用 `/` 分隔的相对路径，
 * 不许空段、`.`、`..`、以 `/` 开头或结尾、反斜杠和控制字符；第一段不能是 `vendor`。
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
 * 一组工程文件哪里不对；没问题时是 undefined。每个路径都要合规、不重复，一个路径不能同时是文件和
 * 别的文件所在的目录，要有主文件。
 */
export function projectProblem(files: readonly ProjectFile[]): string | undefined {
  // 比较时不分大小写：工程写进的临时目录可能在不分大小写的文件系统上
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
  if (!files.some((file) => file.path === MAIN_FILE)) return `工程里没有主文件 ${MAIN_FILE}`
  return undefined
}

const isElement = (node: Node): node is Element => 'tagName' in node

/** `node` 下的全部元素（含 `<template>` 里的），按文件里的先后。 */
export function* elementsOf(node: Node): Generator<Element> {
  if (isElement(node)) yield node
  const children = 'childNodes' in node ? node.childNodes : []
  for (const child of children) yield* elementsOf(child)
  if (isElement(node) && 'content' in node) yield* elementsOf(node.content)
}

function* mediaElements(node: Node): Generator<Element> {
  for (const element of elementsOf(node))
    if (element.tagName === 'video' || element.tagName === 'audio') yield element
}

/** 主文件里 `<video>`、`<audio>` 的 `src` 写的素材地址，不重复。 */
export function mediaAddresses(html: string): string[] {
  const addresses = new Set<string>()
  for (const element of mediaElements(parse(html))) {
    const src = element.attrs.find((attr) => attr.name === 'src')?.value
    if (src !== undefined) addresses.add(src)
  }
  return [...addresses]
}

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

/** 写进 HTML 的一个属性：`name="value"`，值里的 `&`、`"` 转义。 */
export const attributeText = (name: string, value: string) => `${name}="${escapeAttribute(value)}"`

/** 对 `html` 的一处改动：把 `[from, to)` 这段源码换成 `text`（`from === to` 时是插入）。 */
export interface SourceEdit {
  from: number
  to: number
  text: string
}

/** 按源码位置做完 `edits`（互不重叠），别的字一个不动。 */
export function applyEdits(html: string, edits: readonly SourceEdit[]): string {
  let edited = html
  for (const { from, to, text } of edits.toSorted((a, b) => b.from - a.from))
    edited = `${edited.slice(0, from)}${text}${edited.slice(to)}`
  return edited
}

/**
 * 导出用的那一份主文件：`<video>`、`<audio>` 的 `src` 按 `paths`（文件里写的地址 → 本地路径）换掉，
 * 别的内容一个字不动。
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
