/** 工作区是纯文本存储。渲染器按后缀选，不认识任何具体文件名；后缀说不清时再看内容开头。工作区阅读器与审批卡预览共用。 */

/** 渲染器族：Markdown 排成文档，JSON 排成格式化视图，其余按行显示。 */
export type FileKind = 'markdown' | 'json' | 'text'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])

/** 小写后缀；没有后缀（含点开头的隐藏文件）给空串。 */
export const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 没有后缀或后缀陌生的文件，内容以 { 或 [ 开头就按 JSON 试着排。 */
const looksLikeJson = (content: string | undefined): boolean => {
  if (content === undefined) return false
  const head = content.trimStart().charAt(0)
  return head === '{' || head === '['
}

export const fileKindOf = (path: string, content?: string): FileKind => {
  const extension = extensionOf(path)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (JSON_EXTENSIONS.has(extension) || (extension === '' && looksLikeJson(content))) return 'json'
  return 'text'
}

/** 路径最后一段；面向用户只显示文件名。 */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
