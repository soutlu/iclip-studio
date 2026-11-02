/**
 * 原文编辑器的写法检查：只提示，不阻止保存。输入是编辑器里的全文（行之间是 `\n`），
 * 交出的位置就是编辑器文档里的位置；报错文案按界面书面语写，不出现英文。
 */

import { Text } from '@codemirror/state'
import type { Diagnostic } from '@codemirror/lint'
import type { LintError } from 'markdownlint'
import { lint as markdownlint } from 'markdownlint/sync'

// 只开「确实写错了」的几条：默认规则在现有技能文件上报的大多是行长、表格对齐一类的风格问题。
const MARKDOWN_MESSAGES: Record<string, (error: LintError) => string> = {
  MD011: () => '链接的方括号与圆括号顺序颠倒，应写作 [文字](地址)',
  MD037: () => '加粗或斜体符号内侧有空格，无法生效',
  MD038: () => '行内代码的反引号内侧有空格',
  MD039: () => '链接文字首尾有空格',
  MD042: () => '链接地址为空',
  MD055: () => '表格本行首尾竖线的写法与其他行不一致',
  MD056: (error) => {
    const counts = /Expected: (\d+); Actual: (\d+)/.exec(error.errorDetail ?? '')
    return counts === null
      ? '表格本行的列数与表头不一致'
      : `表格本行有 ${counts[2]} 列，与表头的 ${counts[1]} 列不一致`
  },
}

const MARKDOWN_CONFIG = {
  default: false,
  ...Object.fromEntries(Object.keys(MARKDOWN_MESSAGES).map((rule) => [rule, true])),
}

// 空格类问题只报一个空格的位置，太小看不见；这几条标出 errorContext 那段写错的文字。
const CONTEXT_RULES = new Set(['MD037', 'MD038', 'MD039'])

/** errorContext 在本行里的起点：同一段文字出现多次时，取盖住 errorRange 起点的那一处。 */
const contextStart = (line: string, context: string, near: number | undefined): number => {
  let found = -1
  for (let at = line.indexOf(context); at !== -1; at = line.indexOf(context, at + 1)) {
    if (found === -1) found = at
    if (near !== undefined && at <= near && near < at + context.length) return at
  }
  return found
}

/** 一条 markdownlint 报错在本行里的范围（0 起的列与长度）；找不到时标整行。 */
const markdownSpan = (error: LintError, line: string): [number, number] => {
  const rule = error.ruleNames[0] ?? ''
  const whole: [number, number] = [0, line.length]
  if (rule === 'MD056') return whole
  const [column, length] = error.errorRange ?? []
  const near = column === undefined ? undefined : column - 1
  if (CONTEXT_RULES.has(rule) && error.errorContext) {
    const start = contextStart(line, error.errorContext, near)
    if (start !== -1) return [start, error.errorContext.length]
  }
  if (near !== undefined && length !== undefined) return [near, length]
  return whole
}

export const markdownProblems = (text: string): Diagnostic[] => {
  const doc = Text.of(text.split('\n'))
  const errors = markdownlint({ config: MARKDOWN_CONFIG, strings: { doc: text } })['doc'] ?? []
  const problems: Diagnostic[] = []
  for (const error of errors) {
    const describe = MARKDOWN_MESSAGES[error.ruleNames[0] ?? '']
    if (describe === undefined || error.lineNumber > doc.lines) continue
    const line = doc.line(error.lineNumber)
    const [start, length] = markdownSpan(error, line.text)
    const from = Math.min(line.from + start, line.to)
    const to = Math.min(from + Math.max(length, 1), line.to)
    const message = describe(error)
    // 同一处同一个问题（如链接文字两头各报一次）只留一条，悬停时不重复。
    if (problems.some((p) => p.from === from && p.to === to && p.message === message)) continue
    problems.push({ from, message, severity: 'error', to })
  }
  return problems
}

const JSON_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/expected ',' or '[}\]]'/i, '此处缺少逗号或结束括号'],
  [/expected double-quoted property name/i, '属性名未使用双引号，或此前多一个逗号'],
  [/unterminated string/i, '字符串缺少结束引号'],
  [/unexpected end of json input/i, '内容不完整，缺少结束括号'],
  [/bad control character/i, '字符串中含有未转义的换行或控制字符'],
]
const JSON_FALLBACK = '格式错误，此处含有无效字符'

/** 一个词：字符串（可能没闭合）、数字或字面量、单个标点。 */
const JSON_TOKEN_SOURCE = String.raw`"(?:[^"\\\n]|\\.)*"?|[^\s,:{}[\]]+|\S`
const JSON_TOKEN = new RegExp(`^(?:${JSON_TOKEN_SOURCE})`)
const JSON_TOKENS = new RegExp(JSON_TOKEN_SOURCE, 'g')

/** 解析器报的位置，同 `@codemirror/lang-json` 的 jsonParseLinter；内容没写完时没有位置，取全文末尾。 */
const errorPosition = (message: string, text: string, doc: Text): number => {
  const position = /at position (\d+)/.exec(message)
  if (position !== null) return Math.min(Number(position[1]), text.length)
  const lineColumn = /at line (\d+) column (\d+)/.exec(message)
  if (lineColumn !== null) {
    const line = doc.line(Math.min(Number(lineColumn[1]), doc.lines))
    return Math.min(line.from + Number(lineColumn[2]) - 1, text.length)
  }
  return /unexpected end/i.test(message) ? text.length : 0
}

/** 解析器只给一个点；扩成从这里开始的那个词（前面是空白就跳过），后面没有词时取前面最后一个词。 */
const tokenAround = (text: string, at: number): { from: number; to: number } => {
  const rest = text.slice(at)
  const skipped = rest.length - rest.trimStart().length
  const ahead = JSON_TOKEN.exec(rest.slice(skipped))
  if (ahead !== null) return { from: at + skipped, to: at + skipped + ahead[0].length }
  // 从头切词才知道引号是开是合，倒着找会把上一个字符串的结束引号当成开头。
  const behind = [...text.slice(0, at).matchAll(JSON_TOKENS)].at(-1)
  if (behind === undefined) return { from: at, to: at }
  return { from: behind.index, to: behind.index + behind[0].length }
}

export const jsonProblems = (text: string): Diagnostic[] => {
  // 还没写内容的新文件不算错。
  if (text.trim() === '') return []
  try {
    JSON.parse(text)
    return []
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const at = errorPosition(error.message, text, Text.of(text.split('\n')))
    const message = JSON_MESSAGES.find(([pattern]) => pattern.test(error.message))?.[1]
    return [{ ...tokenAround(text, at), message: message ?? JSON_FALLBACK, severity: 'error' }]
  }
}
