import type { EditorView } from 'prosemirror-view'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import {
  linearNavigation,
  type MentionArrow,
  type MentionNavigation,
  type OptionBox,
} from './mention-navigation'
import { closeMention, mentionPlugin, type MentionMatch } from './mention-plugin'

export type CaretAnchor = {
  getBoundingClientRect: () => DOMRect
  contextElement?: Element | undefined
}

export type MentionOptions = {
  readonly query: boolean
  readonly navigation?: MentionNavigation | undefined
  readonly onPick: (index: number, target: { view: EditorView; match: MentionMatch }) => void
}

const ARROWS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
const isArrow = (key: string): key is MentionArrow => ARROWS.has(key)

const boxesOf = (list: HTMLElement | null): OptionBox[] =>
  [...(list?.querySelectorAll('[role="option"]') ?? [])].map((option) => {
    const { height, left, top, width } = option.getBoundingClientRect()
    return { height, left, top, width }
  })

const caretRect = (view: EditorView | null, match: MentionMatch | null): DOMRect => {
  const { bottom, left, top } =
    view === null || match === null
      ? { bottom: 0, left: 0, top: 0 }
      : view.coordsAtPos(match.at + 1)
  const rect = { bottom, height: bottom - top, left, right: left, top, width: 0, x: left, y: top }
  return { ...rect, toJSON: () => rect }
}

export const useMention = (
  viewRef: RefObject<EditorView | null>,
  options: MentionOptions | undefined,
) => {
  const [match, setMatch] = useState<MentionMatch | null>(null)
  const [active, setActive] = useState(0)
  const latestRef = useRef({ active, match, options })
  useEffect(() => {
    latestRef.current = { active, match, options }
  })
  const listRef = useRef<HTMLElement | null>(null)
  const setList = useCallback((list: HTMLElement | null) => {
    listRef.current = list
  }, [])
  const anchorRef = useRef<CaretAnchor>({
    getBoundingClientRect: () => caretRect(viewRef.current, latestRef.current.match),
    get contextElement() {
      return viewRef.current?.dom
    },
  })

  const pick = (index: number) => {
    const view = viewRef.current
    const { match: current, options: latest } = latestRef.current
    if (view === null || current === null || latest === undefined) return
    latest.onPick(index, { match: current, view })
  }

  const moveTo = (index: number) => {
    latestRef.current.active = index
    setActive(index)
  }
  const onKey = (key: string): boolean => {
    const { active: current, options: latest } = latestRef.current
    if (key === 'Enter') {
      if (current < boxesOf(listRef.current).length) pick(current)
      return true
    }
    const navigation = latest?.navigation ?? linearNavigation
    if (!isArrow(key) || !navigation.arrows.includes(key)) return false
    moveTo(navigation.next(current, key, boxesOf(listRef.current)))
    return true
  }
  const createPlugin = () =>
    mentionPlugin({
      enabled: () => latestRef.current.options !== undefined,
      onChange: (next) => {
        latestRef.current.match = next
        setMatch(next)
        moveTo(0)
      },
      onKey,
      query: () => latestRef.current.options?.query === true,
    })

  const close = useCallback(() => {
    if (viewRef.current !== null) closeMention(viewRef.current)
  }, [viewRef])
  const open = match !== null && options !== undefined
  useEscapeAheadOfDialog(open, close)

  return {
    createPlugin,
    close,
    menu: open
      ? {
          active,
          anchor: anchorRef,
          listRef: setList,
          match,
          onClose: close,
          pick,
        }
      : undefined,
  }
}
