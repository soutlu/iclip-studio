import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

export type TypedInput = { text: string; editable: boolean; composing: boolean }

export const opensMention = ({ composing, editable, text }: TypedInput): boolean =>
  editable && !composing && text === '@'

export type MentionMatch = { readonly at: number; readonly query: string }

type MentionState = MentionMatch | null

const mentionKey = new PluginKey<MentionState>('mention')

export type MentionPluginEvents = {
  query: () => boolean
  enabled: () => boolean
  onChange: (match: MentionState) => void
  onKey: (key: string) => boolean
}

const mentionOf = (state: EditorState): MentionState => mentionKey.getState(state) ?? null

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

export function selectMention(view: EditorView) {
  const match = mentionOf(view.state)
  if (match === null) return
  const end = match.at + 1 + match.query.length
  const selection = TextSelection.create(view.state.doc, match.at, end)
  view.dispatch(view.state.tr.setSelection(selection).setMeta(mentionKey, null))
}
