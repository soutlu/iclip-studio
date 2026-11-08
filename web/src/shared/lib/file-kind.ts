export type FileKind = 'markdown' | 'json' | 'text'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])

export const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

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

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
