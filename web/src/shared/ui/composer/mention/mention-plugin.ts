/** 正文里敲 `@` 打开菜单的 ProseMirror 插件：记下这个 `@` 的位置（查询模式下还有查询词），打开期间把按键转给菜单；
 * 菜单由 React 渲染，选中后怎么改文档由使用方决定。
 *
 * 选区展开、`@` 被删、编辑器失焦时关闭；非查询模式下光标离开 `@` 之后（包括再敲字）即关，
 * 查询模式下光标离开 `@` 之后到查询词末尾这一段、或查询词里出现空白 / `@` / 行内节点即关。Esc 只关菜单，文字原样留着。 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

/** 一次键入：打的字、编辑器此刻能不能改、是否还在输入法组合中。粘贴与撤销不算键入。 */
export type TypedInput = { text: string; editable: boolean; composing: boolean }

/** 可编辑、不在输入法组合中、键入的正好是一个 `@` 才打开菜单；前面是什么字符都不挑。 */
export const opensMention = ({ composing, editable, text }: TypedInput): boolean =>
  editable && !composing && text === '@'

/** 打开着的 `@`：`at` 是它在文档里的位置；`query` 是它之后到光标之前的字，非查询模式下恒为空串。 */
export type MentionMatch = { readonly at: number; readonly query: string }

type MentionState = MentionMatch | null

const mentionKey = new PluginKey<MentionState>('mention')

export type MentionPluginEvents = {
  /** 是否带查询词；每笔事务都读，所以可以随使用方变化。 */
  query: () => boolean
  /** 编辑器此刻是否提供菜单；不提供时敲 `@` 就是普通字符。 */
  enabled: () => boolean
  /** 打开、关闭或查询词变化。 */
  onChange: (match: MentionState) => void
  /** 打开期间按下的键（Esc 除外，插件自己关菜单）；返回 true 表示菜单接管了这个键。 */
  onKey: (key: string) => boolean
}

const mentionOf = (state: EditorState): MentionState => mentionKey.getState(state) ?? null

/** 映射之后的 `at` 处是否还是那个打开着的 `@`；是的话按当前光标给出查询词。 */
const matchAt = (state: EditorState, at: number, query: boolean): MentionState => {
  const { $from, empty, from } = state.selection
  if (!empty || from <= at) return null
  if (state.doc.textBetween(at, at + 1) !== '@') return null
  if (!query) return from === at + 1 ? { at, query: '' } : null
  if (!state.doc.resolve(at).sameParent($from)) return null
  const text = state.doc.textBetween(at + 1, from, undefined, '￼')
  return /[\s@￼]/.test(text) ? null : { at, query: text }
}

const sameMatch = (a: MentionState, b: MentionState) =>
  a === b || (a !== null && b !== null && a.at === b.at && a.query === b.query)

export const mentionPlugin = (events: MentionPluginEvents) =>
  new Plugin<MentionState>({
    key: mentionKey,
    state: {
      init: () => null,
      apply(tr, previous, _old, next) {
        const meta = tr.getMeta(mentionKey) as MentionState | undefined
        if (meta !== undefined) return meta
        if (previous === null) return null
        const match = matchAt(next, tr.mapping.map(previous.at, -1), events.query())
        return sameMatch(match, previous) ? previous : match
      },
    },
    props: {
      handleTextInput(view, from, _to, text, insert) {
        const typed = { composing: view.composing, editable: view.editable, text }
        if (!events.enabled() || !opensMention(typed)) return false
        view.dispatch(insert().setMeta(mentionKey, { at: from, query: '' }))
        return true
      },
      handleKeyDown(view, event) {
        // 输入法组合中的方向键、Enter 与 Esc 归输入法。
        if (mentionOf(view.state) === null || event.isComposing) return false
        if (event.key === 'Escape') {
          closeMention(view)
          return true
        }
        return events.onKey(event.key)
      },
      handleDOMEvents: {
        blur: (view) => {
          closeMention(view)
          return false
        },
      },
    },
    view: () => ({
      update(view, previous) {
        const match = mentionOf(view.state)
        if (!sameMatch(match, mentionOf(previous))) events.onChange(match)
      },
    }),
  })

export function closeMention(view: EditorView) {
  if (mentionOf(view.state) !== null) view.dispatch(view.state.tr.setMeta(mentionKey, null))
}

/** 在使用方自己的事务里一并关掉菜单：替换文档与关菜单是同一步，撤销时不会单独留下一步。 */
export const closingMention = (tr: Transaction): Transaction => tr.setMeta(mentionKey, null)

/** 选区盖住 `@` 与查询词并关掉菜单：之后按选区插入的入口会把它换掉，取消时文字还在。 */
export function selectMention(view: EditorView) {
  const match = mentionOf(view.state)
  if (match === null) return
  const end = match.at + 1 + match.query.length
  const selection = TextSelection.create(view.state.doc, match.at, end)
  view.dispatch(closingMention(view.state.tr.setSelection(selection)))
}
