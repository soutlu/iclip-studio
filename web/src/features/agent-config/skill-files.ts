/**
 * 技能文件的纯逻辑：`SKILL.md` 的 frontmatter 读写、编辑器里显示的正文、参考文件的路径规则。
 * 编辑器不显示 frontmatter：说明在标题下面改，改了只重写 frontmatter 里的 `description`，别的键原样留着。
 * 文件规则见合同 §17「文件」。
 */

export const SKILL_MD = 'SKILL.md'
const REFERENCES = 'references/'

type Frontmatter = {
  /** `---` 之间的 YAML，不含两条分隔线。 */
  header: string
  /** 从文件开头到结尾那条 `---`（含它的换行）的原文。 */
  block: string
  /** frontmatter 之后的原文。 */
  body: string
  eol: string
}

// 与后端同一个写法：文件第一行就是 `---`。
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

/**
 * 编辑器里显示的正文：`SKILL.md` 去掉 frontmatter 与紧跟的空行。
 * 去掉空行是为了让编辑器交出的值与再读出来的正文一字不差，否则每改一个字都会整篇重载。
 */
export const skillBody = (source: string): string =>
  (splitFrontmatter(source)?.body ?? source).replace(LEADING_BLANK_LINES, '')

/** 用编辑器交出的正文换掉 `SKILL.md` 的正文，frontmatter 原样留着，中间空一行。 */
export const withSkillBody = (source: string, body: string): string => {
  const parts = splitFrontmatter(source)
  if (parts === null) return body
  const block = /\n$/.test(parts.block) ? parts.block : `${parts.block}${parts.eol}`
  return `${block}${parts.eol}${body}`
}

/** 顶层键 `key` 所在的行与它的续行（缩进的行、空行）的范围；没有为 null。 */
const fieldRange = (lines: readonly string[], key: string) => {
  const start = lines.findIndex((line) => new RegExp(`^${key}[ \\t]*:`).test(line))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && /^(?:[ \t]|$)/.test(lines[end] ?? '')) end += 1
  // 续行末尾的空行不算这个键的，留给后面。
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

/** 块标量（`|` 保留换行，`>` 折成一行，段落间留换行）：去掉公共缩进。 */
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

/**
 * `SKILL.md` 的 frontmatter 里的 `description`；没有 frontmatter 或没写为 null。
 * 认 YAML 的普通、双引号、单引号与块标量写法，够读本系统与常见技能包写出来的文件。
 * 引号里的原样交回（输入框边打边写回，词间的空格不能被吃掉），其余写法去掉首尾空白。
 */
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

/**
 * 把说明写进 `SKILL.md` 的 frontmatter：只换 `description` 这一项（写成双引号字符串，JSON 的写法也是合法的 YAML），
 * 别的键、正文都原样留着。没有 frontmatter 时补一份，带上技能标识 `name`（发布时要求有）。
 */
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

/** 用富文本编辑器打开的文件；别的参考文件（json、yaml、txt 等）用纯文本编辑。 */
export const isMarkdownPath = (path: string): boolean => /\.(?:md|markdown)$/i.test(path)

/** 页签上显示的名字：参考文件去掉 `references/`。 */
export const fileLabel = (path: string): string =>
  path.startsWith(REFERENCES) ? path.slice(REFERENCES.length) : path

/** `SKILL.md` 在最前，参考文件按路径排。 */
export const sortSkillPaths = (paths: Iterable<string>): string[] =>
  [...paths].sort((a, b) => (a === SKILL_MD ? -1 : b === SKILL_MD ? 1 : a < b ? -1 : a > b ? 1 : 0))

/**
 * 把输入的参考文件名变成 `references/` 下的路径；不合格时交回原因。规则同合同 §17「文件」：
 * 相对的 posix 路径，不许反斜杠、空段与 `.`、`..`。`previous` 是改名前的路径，与它相同不算重名。
 */
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
