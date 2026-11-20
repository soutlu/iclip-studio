import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { linter } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type Command,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { FileKind } from '@/shared/lib/file-kind'
import { jsonProblems, markdownProblems } from './lint'

const codeStyle = HighlightStyle.define([
  { color: 'var(--color-code-key)', tag: t.heading },
  { color: 'var(--color-code-literal)', tag: [t.strong, t.emphasis] },
  { color: 'var(--color-on-surface-muted)', tag: t.strikethrough },
  { color: 'var(--color-on-surface-variant)', tag: t.quote },
  { color: 'var(--color-primary)', tag: t.link },
  { color: 'var(--color-code-string)', tag: t.monospace },
  { color: 'var(--color-code-literal)', tag: t.atom },
  {
    color: 'var(--color-code-key)',
    tag: [t.keyword, t.tagName, t.propertyName, t.definitionKeyword],
  },
  { color: 'var(--color-code-string)', tag: [t.string, t.attributeValue, t.special(t.string)] },
  { color: 'var(--color-code-literal)', tag: [t.number, t.bool, t.null, t.attributeName] },
  { color: 'var(--color-on-surface-faint)', tag: [t.comment, t.lineComment, t.blockComment] },
  {
    color: 'var(--color-on-surface-muted)',
    tag: [t.angleBracket, t.punctuation, t.separator, t.brace, t.squareBracket, t.paren],
  },
  { color: 'var(--color-on-surface-muted)', tag: t.url },
  {
    color: 'var(--color-on-surface-faint)',
    tag: [t.processingInstruction, t.contentSeparator, t.labelName],
  },
])

const PHRASES = EditorState.phrases.of({
  'Control character': '控制字符',
  Find: '查找',
  'Go to line': '跳转到行',
  Replace: '替换为',
  'Selection deleted': '已删除选中内容',
  all: '全部选中',
  'by word': '全词匹配',
  close: '关闭',
  'current match': '当前匹配项',
  go: '跳转',
  'match case': '区分大小写',
  next: '下一处',
  'on line': '所在行',
  previous: '上一处',
  regexp: '正则表达式',
  replace: '替换',
  'replace all': '全部替换',
  'replaced $ matches': '已替换 $ 处',
  'replaced match on line $': '已替换第 $ 行的匹配项',
})

// 编辑器和只读查看器都要的：高亮、选中、查找、折行与中文提示
const READING: Extension = [
  highlightSpecialChars(),
  drawSelection(),
  highlightSelectionMatches(),
  search({ top: true }),
  EditorView.lineWrapping,
  syntaxHighlighting(codeStyle),
  PHRASES,
  EditorView.contentAttributes.of({ spellcheck: 'false' }),
]

export const BASE: Extension = [
  READING,
  history(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  rectangularSelection(),
  crosshairCursor(),
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
]

/** 只读查看：可聚焦、可选中复制、可查找，带行号与折叠；不改内容，也不做写法检查。 */
export const VIEWER: Extension = [
  READING,
  EditorState.readOnly.of(true),
  lineNumbers(),
  foldGutter(),
  bracketMatching(),
  keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]),
]

const wrapWith =
  (marker: string): Command =>
  (view) => {
    const { state } = view
    const n = marker.length
    const spec = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - n, range.from)
      const after = state.sliceDoc(range.to, range.to + n)
      if (!range.empty && before === marker && after === marker)
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n },
          ],
          range: EditorSelection.range(range.anchor - n, range.head - n),
        }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.anchor + n, range.head + n),
      }
    })
    view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }

const LANGUAGES: Record<FileKind, Extension> = {
  json: [json(), linter((view) => jsonProblems(view.state.doc.toString()))],
  markdown: [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    linter((view) => markdownProblems(view.state.doc.toString())),
    Prec.high(
      keymap.of([
        { key: 'Mod-b', run: wrapWith('**') },
        { key: 'Mod-i', run: wrapWith('*') },
      ]),
    ),
  ],
  text: [],
}

export const languageFor = (kind: FileKind): Extension => LANGUAGES[kind]

/**
 * 只读查看用的语言：JSON 直接给（不带写法检查），其余按文件名在语言表里找，多数语言要异步加载。
 * 找不到时返回 `null`，按纯文本显示。
 */
export const viewerLanguageFor = (
  kind: FileKind,
  fileName: string,
): Extension | LanguageDescription | null =>
  kind === 'json' ? json() : LanguageDescription.matchFilename(languages, fileName)
