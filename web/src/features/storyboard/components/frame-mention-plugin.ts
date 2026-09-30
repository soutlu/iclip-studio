/** 正文里敲 `@` 选图的 ProseMirror 插件：记下这个 `@` 的位置，打开期间接管方向键、Enter 与 Esc；弹层由 React 渲染。
 *
 * 光标离开 `@` 之后、选区展开、`@` 被删或编辑器失焦时自动关闭；Esc 只关弹层，字面 `@` 留着。 */

import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { opensFrameMention, textAfterMention, type MentionArrow } from '../frame-mention'
import { docToPrompt, promptOffsetAt, promptPositionAt, promptToDoc } from './prompt-editor-doc'

/** 打开时是那个 `@` 在文档里的位置，关闭时为 null。 */
type MentionState = number | null

const mentionKey = new PluginKey<MentionState>('frame-mention')

export type MentionKey = MentionArrow | 'Enter'

const MENTION_KEYS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'])
const isMentionKey = (key: string): key is MentionKey => MENTION_KEYS.has(key)

export type FrameMentionEvents = {
  /** 编辑器此刻是否提供选图；不提供时敲 `@` 就是普通字符。 */
  enabled: () => boolean
  /** 开合变化：打开时给 `@` 的位置。 */
  onChange: (at: MentionState) => void
  /** 打开期间按下的方向键与 Enter，由弹层决定怎么走、选哪格。 */
  onKey: (key: MentionKey) => void
}

const mentionAt = (state: EditorState): MentionState => mentionKey.getState(state) ?? null

const stillAtTrigger = (state: EditorState, at: number) =>
  state.selection.empty &&
  state.selection.from === at + 1 &&
  state.doc.textBetween(at, at + 1) === '@'

export const frameMentionPlugin = (events: FrameMentionEvents) =>
  new Plugin<MentionState>({
    key: mentionKey,
    state: {
      init: () => null,
      apply(tr, previous, _old, next) {
        const meta = tr.getMeta(mentionKey) as MentionState | undefined
        if (meta !== undefined) return meta
        if (previous === null) return null
        const at = tr.mapping.map(previous, -1)
        return stillAtTrigger(next, at) ? at : null
      },
    },
    props: {
      handleTextInput(view, from, _to, text, insert) {
        const typed = { composing: view.composing, editable: view.editable, text }
        if (!events.enabled() || !opensFrameMention(typed)) return false
        view.dispatch(insert().setMeta(mentionKey, from))
        return true
      },
      handleKeyDown(view, event) {
        if (mentionAt(view.state) === null) return false
        if (event.key === 'Escape') {
          closeFrameMention(view)
          return true
        }
        if (!isMentionKey(event.key)) return false
        events.onKey(event.key)
        return true
      },
      handleDOMEvents: {
        blur: (view) => {
          closeFrameMention(view)
          return false
        },
      },
    },
    view: () => ({
      update(view, previous) {
        const at = mentionAt(view.state)
        if (at !== mentionAt(previous)) events.onChange(at)
      },
    }),
  })

export function closeFrameMention(view: EditorView) {
  if (mentionAt(view.state) !== null) view.dispatch(view.state.tr.setMeta(mentionKey, null))
}

/** 把这个 `@` 换成第 `frame` 帧的引用，光标落在引用之后；正文怎么变由 `textAfterMention` 定。 */
export function insertMentionedFrame(view: EditorView, frame: number) {
  const at = mentionAt(view.state)
  if (at === null) return
  const { doc } = view.state
  const next = textAfterMention(docToPrompt(doc), promptOffsetAt(doc, at), frame)
  if (next === undefined) return
  const tr = view.state.tr.replaceWith(0, doc.content.size, promptToDoc(next.text).content)
  tr.setSelection(TextSelection.create(tr.doc, promptPositionAt(tr.doc, next.cursor)))
  view.dispatch(tr.setMeta(mentionKey, null).scrollIntoView())
}

/** 选区盖住这个 `@` 并关掉弹层：之后按光标插引用的入口（添加图片）会把它换掉，取消时字面 `@` 还在。 */
export function selectMentionTrigger(view: EditorView) {
  const at = mentionAt(view.state)
  if (at === null) return
  const selection = TextSelection.create(view.state.doc, at, at + 1)
  view.dispatch(view.state.tr.setSelection(selection).setMeta(mentionKey, null))
}
