/** PromptEditor 里 `@` 选图的 React 一侧：持有开合与键盘停在的格子，把插件的事件接到弹层上。 */

import type { EditorView } from 'prosemirror-view'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from '@/shared/ui/toast'
import { optionAfterArrow, type OptionBox } from '../frame-mention'
import {
  closeFrameMention,
  frameMentionPlugin,
  insertMentionedFrame,
  selectMentionTrigger,
  type MentionKey,
} from './frame-mention-plugin'
import type { CaretAnchor } from './frame-mention-menu'
import type { FrameAdd } from './frame-tile'

/** 编辑器提供 `@` 选图时要给的：末格「+」走的添加入口，以及插入第几帧之后要做的事（比如舞台切过去）。 */
export type FrameMentionOptions = {
  add: FrameAdd
  onInserted: (frame: number) => void
}

const boxesOf = (list: HTMLUListElement | null): OptionBox[] =>
  [...(list?.querySelectorAll('[role="option"]') ?? [])].map((option) => {
    const { height, left, top, width } = option.getBoundingClientRect()
    return { height, left, top, width }
  })

const caretRect = (view: EditorView | null, at: number | null): DOMRect => {
  const { bottom, left, top } =
    view === null || at === null ? { bottom: 0, left: 0, top: 0 } : view.coordsAtPos(at + 1)
  const rect = { bottom, height: bottom - top, left, right: left, top, width: 0, x: left, y: top }
  return { ...rect, toJSON: () => rect }
}

export const useFrameMention = (
  viewRef: RefObject<EditorView | null>,
  options: FrameMentionOptions | undefined,
  frameCount: number,
) => {
  const [at, setAt] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const latestRef = useRef({ active, at, frameCount, options })
  useEffect(() => {
    latestRef.current = { active, at, frameCount, options }
  })
  const listRef = useRef<HTMLUListElement | null>(null)
  const anchorRef = useRef<CaretAnchor>({
    getBoundingClientRect: () => caretRect(viewRef.current, latestRef.current.at),
    get contextElement() {
      return viewRef.current?.dom
    },
  })

  /** 选第 `index` 格：图片就把 `@` 换成引用；「+」就让选区盖住 `@` 再走添加入口，添加完成时它被换掉。 */
  const pick = (index: number) => {
    const view = viewRef.current
    const { frameCount: count, options: current } = latestRef.current
    if (view === null || current === undefined) return
    if (index < count) {
      insertMentionedFrame(view, index + 1)
      current.onInserted(index + 1)
      return
    }
    if (current.add.blocker !== undefined) {
      toast.error(current.add.blocker)
      return
    }
    selectMentionTrigger(view)
    current.add.onAdd()
  }

  // 连按的键可能赶在重渲染之前，开合与选中格先同步写进 ref。
  const moveTo = (index: number) => {
    latestRef.current.active = index
    setActive(index)
  }
  const onKey = (key: MentionKey) => {
    const { active: current } = latestRef.current
    if (key === 'Enter') pick(current)
    else moveTo(optionAfterArrow(current, key, boxesOf(listRef.current)))
  }
  // 编辑器建好时调一次；插件里的回调只读 ref 和 setter，首轮渲染的闭包一直可用。
  const createPlugin = () =>
    frameMentionPlugin({
      enabled: () => latestRef.current.options !== undefined,
      onChange: (next) => {
        latestRef.current.at = next
        setAt(next)
        moveTo(0)
      },
      onKey,
    })

  const close = useCallback(() => {
    if (viewRef.current !== null) closeFrameMention(viewRef.current)
  }, [viewRef])

  return {
    /** 建编辑器时调一次，插件放进编辑器的插件列表。 */
    createPlugin,
    close,
    /** 弹层要的数据；没打开或不提供选图时为 undefined。 */
    menu:
      at === null || options === undefined
        ? undefined
        : {
            active,
            add: { blocker: options.add.blocker, onAdd: () => pick(frameCount) },
            anchor: anchorRef,
            listRef,
            onClose: close,
            onPick: (frame: number) => pick(frame - 1),
          },
  }
}
