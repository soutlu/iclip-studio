/** PromptEditor 里 `@` 选图：在 shared 的 `@` 菜单内核上接分镜的规则——不带查询词、格子按网格走，
 * 选图片把 `@` 换成引用，选末格「+」走添加入口。 */

import type { EditorView } from 'prosemirror-view'
import type { RefObject } from 'react'
import { gridNavigation, selectMention, useMention } from '@/shared/ui/composer/mention'
import type { FrameAdd } from './frame-tile'

/** 编辑器提供 `@` 选图时要给的：末格「+」走的添加入口，以及插入第几帧之后要做的事（比如舞台切过去）。 */
export type FrameMentionOptions = {
  add: FrameAdd
  onInserted: (frame: number) => void
}

export const useFrameMention = (
  viewRef: RefObject<EditorView | null>,
  options: FrameMentionOptions | undefined,
  frameCount: number,
  /** 把选区换成第 `frame` 帧的引用，光标落在引用之后。 */
  insertFrame: (frame: number) => void,
) => {
  const mention = useMention(
    viewRef,
    options === undefined
      ? undefined
      : {
          navigation: gridNavigation,
          /** 选第 `index` 格：选区先盖住 `@`（同时关菜单），图片就把它换成引用；「+」留着它走添加入口，添加完成时它被换掉。 */
          onPick: (index, { view }) => {
            selectMention(view)
            if (index < frameCount) {
              insertFrame(index + 1)
              options.onInserted(index + 1)
              return
            }
            options.add()
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
            onAdd: () => menu.pick(frameCount),
            anchor: menu.anchor,
            listRef: menu.listRef,
            onClose: menu.onClose,
            onPick: (frame: number) => menu.pick(frame - 1),
          },
  }
}
