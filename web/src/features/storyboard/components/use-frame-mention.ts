/** PromptEditor 里 `@` 选图：在 shared 的 `@` 菜单内核上接分镜的规则——不带查询词、格子按网格走，
 * 选图片把 `@` 换成引用，选末格「+」走添加入口。 */

import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { RefObject } from 'react'
import {
  closingMention,
  gridNavigation,
  selectMention,
  useMention,
} from '@/shared/ui/composer/mention'
import { toast } from '@/shared/ui/toast'
import { textAfterMention } from '../frame-mention'
import type { FrameAdd } from './frame-tile'
import { docToPrompt, promptOffsetAt, promptPositionAt, promptToDoc } from './prompt-editor-doc'

/** 编辑器提供 `@` 选图时要给的：末格「+」走的添加入口，以及插入第几帧之后要做的事（比如舞台切过去）。 */
export type FrameMentionOptions = {
  add: FrameAdd
  onInserted: (frame: number) => void
}

/** 把 `at` 处的 `@` 换成第 `frame` 帧的引用，光标落在引用之后；正文怎么变由 `textAfterMention` 定。 */
const insertMentionedFrame = (view: EditorView, at: number, frame: number) => {
  const { doc } = view.state
  const next = textAfterMention(docToPrompt(doc), promptOffsetAt(doc, at), frame)
  if (next === undefined) return
  const tr = view.state.tr.replaceWith(0, doc.content.size, promptToDoc(next.text).content)
  tr.setSelection(TextSelection.create(tr.doc, promptPositionAt(tr.doc, next.cursor)))
  view.dispatch(closingMention(tr).scrollIntoView())
}

export const useFrameMention = (
  viewRef: RefObject<EditorView | null>,
  options: FrameMentionOptions | undefined,
  frameCount: number,
) => {
  const mention = useMention(
    viewRef,
    options === undefined
      ? undefined
      : {
          navigation: gridNavigation,
          /** 选第 `index` 格：图片就把 `@` 换成引用；「+」就让选区盖住 `@` 再走添加入口，添加完成时它被换掉。 */
          onPick: (index, { match, view }) => {
            if (index < frameCount) {
              insertMentionedFrame(view, match.at, index + 1)
              options.onInserted(index + 1)
              return
            }
            if (options.add.blocker !== undefined) {
              toast.error(options.add.blocker)
              return
            }
            selectMention(view)
            options.add.onAdd()
          },
          query: false,
        },
  )
  const { menu } = mention

  return {
    /** 建编辑器时调一次，插件放进编辑器的插件列表。 */
    createPlugin: mention.createPlugin,
    close: mention.close,
    /** 弹层要的数据；没打开或不提供选图时为 undefined。 */
    menu:
      menu === undefined || options === undefined
        ? undefined
        : {
            active: menu.active,
            add: { blocker: options.add.blocker, onAdd: () => menu.pick(frameCount) },
            anchor: menu.anchor,
            listRef: menu.listRef,
            onClose: menu.onClose,
            onPick: (frame: number) => menu.pick(frame - 1),
          },
  }
}
