/** `@` 菜单的 React 一侧：持有开合、查询词与键盘停在的项，把插件转来的键接到菜单上。
 *
 * 菜单长什么样、选中后文档怎么变都归使用方：它渲染 `role="option"` 的列表并挂上 `listRef`，在 `onPick` 里改文档。 */

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

/** 光标所在的矩形；`contextElement` 让弹层跟着编辑器所在的滚动容器走。 */
export type CaretAnchor = {
  getBoundingClientRect: () => DOMRect
  contextElement?: Element | undefined
}

export type MentionOptions = {
  /** true：`@` 之后到光标之前的字是查询词，敲字更新查询；false：`@` 之后敲任何字菜单即关。 */
  readonly query: boolean
  /** 方向键怎么走；默认 `linearNavigation`。 */
  readonly navigation?: MentionNavigation | undefined
  /** 选中第 `index` 项（列表里 `role="option"` 的顺序）。文档怎么改、改完关不关菜单由使用方决定，
   * 关菜单用 `closingMention` 并进自己的事务，或用 `selectMention` 让选区盖住 `@` 留给别的入口替换。 */
  readonly onPick: (index: number, target: { view: EditorView; match: MentionMatch }) => void
}

const ARROWS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
const isArrow = (key: string): key is MentionArrow => ARROWS.has(key)

const boxesOf = (list: HTMLElement | null): OptionBox[] =>
  [...(list?.querySelectorAll('[role="option"]') ?? [])].map((option) => {
    const { height, left, top, width } = option.getBoundingClientRect()
    return { height, left, top, width }
  })

/** 锚在 `@` 之后：查询模式下敲字时菜单不跟着光标挪。 */
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

  // 连按的键可能赶在重渲染之前，开合与选中项先同步写进 ref。
  const moveTo = (index: number) => {
    latestRef.current.active = index
    setActive(index)
  }
  const onKey = (key: string): boolean => {
    const { active: current, options: latest } = latestRef.current
    if (key === 'Enter') {
      // 查询词筛空了列表时 Enter 什么也不选，也不换行。
      if (current < boxesOf(listRef.current).length) pick(current)
      return true
    }
    const navigation = latest?.navigation ?? linearNavigation
    if (!isArrow(key) || !navigation.arrows.includes(key)) return false
    moveTo(navigation.next(current, key, boxesOf(listRef.current)))
    return true
  }
  // 编辑器建好时调一次；插件里的回调只读 ref 和 setter，首轮渲染的闭包一直可用。
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
  // 编辑器可能在弹窗里：Esc 先关菜单，不连弹窗一起关。
  useEscapeAheadOfDialog(open, close)

  return {
    /** 建编辑器时调一次，插件放进编辑器的插件列表，排在 keymap 之前，打开时的 Enter 与方向键先归菜单。 */
    createPlugin,
    close,
    /** 菜单要的数据；没打开或不提供菜单时为 undefined。 */
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
