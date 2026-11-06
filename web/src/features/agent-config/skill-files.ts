export const SKILL_MD = 'SKILL.md'
const REFERENCES = 'references/'

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_NAME = 64
export const NAME_RULE = `标识只能用小写字母、数字和连字符，不以连字符开头或结尾、不连用，最多 ${MAX_NAME} 个字符`

export const isValidName = (name: string): boolean =>
  name.length <= MAX_NAME && NAME_PATTERN.test(name)

type Frontmatter = {
  header: string
  block: string
  body: string
  eol: string
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

const splitFrontmatter = (source: string): Frontmatter | null => {
  const match = FRONTMATTER.exec(source)
  if (match === null) return null
  return {
    block: match[0],
    body: source.slice(match[0].length),
    eol: source.includes('\r\n') ? '\r\n' : '\n',
    header: match[1] ?? '',
  }
}

const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/

export const skillBody = (source: string): string => {
  const parts = splitFrontmatter(source)
  return parts === null ? source : parts.body.replace(/^\r?\n/, '')
}

export const withSkillBody = (source: string, body: string): string => {
  const parts = splitFrontmatter(source)
  if (parts === null) return body
  const block = /\n$/.test(parts.block) ? parts.block : `${parts.block}${parts.eol}`
  return `${block}${parts.eol}${body}`
}

const fieldRange = (lines: readonly string[], key: string) => {
  const start = lines.findIndex((line) => new RegExp(`^${key}[ \\t]*:`).test(line))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && /^(?:[ \t]|$)/.test(lines[end] ?? '')) end += 1
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1
  return { end, start }
}

const readDoubleQuoted = (text: string): string => {
  const close = /^"((?:[^"\\]|\\.)*)"/.exec(text)
  if (close === null) return text.slice(1)
  try {
    return JSON.parse(`"${close[1] ?? ''}"`) as string
  } catch {
    return close[1] ?? ''
  }
}

const readSingleQuoted = (text: string): string => {
  const close = /^'((?:[^']|'')*)'/.exec(text)
  return (close === null ? text.slice(1) : (close[1] ?? '')).replaceAll("''", "'")
}

const readBlock = (indicator: string, lines: readonly string[]): string => {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0)
  const indent = indents.length === 0 ? 0 : Math.min(...indents)
  const stripped = lines.map((line) => line.slice(indent))
  if (indicator.startsWith('|')) return stripped.join('\n').trim()
  return stripped
    .join('\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.split('\n').join(' ').trim())
    .join('\n')
    .trim()
}

export const readDescription = (source: string): string | null => {
  const parts = splitFrontmatter(source)
  if (parts === null) return null
  const lines = parts.header.split(/\r?\n/)
  const range = fieldRange(lines, 'description')
  if (range === null) return null
  const first = (lines[range.start] ?? '').replace(/^description[ \t]*:/, '').trim()
  const rest = lines.slice(range.start + 1, range.end)
  if (first.startsWith('|') || first.startsWith('>')) return readBlock(first, rest)
  const joined = [first, ...rest.map((line) => line.trim())].filter(Boolean).join(' ')
  if (joined.startsWith('"')) return readDoubleQuoted(joined)
  if (joined.startsWith("'")) return readSingleQuoted(joined)
  return joined.replace(/\s+#.*$/, '').trim()
}

export const withDescription = (source: string, description: string, name: string): string => {
  const field = `description: ${JSON.stringify(description)}`
  const parts = splitFrontmatter(source)
  if (parts === null) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n'
    const body = source.replace(LEADING_BLANK_LINES, '')
    return `---${eol}name: ${name}${eol}${field}${eol}---${eol}${eol}${body}`
  }
  const lines = parts.header === '' ? [] : parts.header.split(/\r?\n/)
  const range = fieldRange(lines, 'description')
  const next =
    range === null
      ? [...lines, field]
      : [...lines.slice(0, range.start), field, ...lines.slice(range.end)]
  const { eol } = parts
  return `---${eol}${next.join(eol)}${eol}---${eol}${parts.body}`
}

export const fileLabel = (path: string): string =>
  path.startsWith(REFERENCES) ? path.slice(REFERENCES.length) : path

export const sortSkillPaths = (paths: Iterable<string>): string[] =>
  [...paths].sort((a, b) => (a === SKILL_MD ? -1 : b === SKILL_MD ? 1 : a < b ? -1 : a > b ? 1 : 0))

export const referencePath = (
  input: string,
  existing: readonly string[],
  previous?: string,
): { path: string } | { error: string } => {
  const name = input.trim()
  if (name === '') return { error: '请填写文件名' }
  // eslint-disable-next-line no-control-regex -- 拦的就是控制字符
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: '文件名不能包含换行或控制字符' }
  if (name.startsWith('/')) return { error: '请填写 references/ 下的相对路径' }
  if (name.includes('\\')) return { error: '路径不能包含反斜杠，请用 / 分隔目录' }
  const path = name.startsWith(REFERENCES) ? name : `${REFERENCES}${name}`
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..'))
    return { error: '路径里不能有空的一段、. 或 ..' }
  if (path !== previous && existing.includes(path)) return { error: '已有同名文件，请换一个文件名' }
  return { path }
}
