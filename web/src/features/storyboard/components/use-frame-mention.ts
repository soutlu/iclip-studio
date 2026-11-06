import type { EditorView } from 'prosemirror-view'
import type { RefObject } from 'react'
import { gridNavigation, selectMention, useMention } from '@/shared/ui/composer/mention'
import type { FrameAdd } from './frame-tile'

export type FrameMentionOptions = {
  add: FrameAdd
  onInserted: (frame: number) => void
}

export const useFrameMention = (
  viewRef: RefObject<EditorView | null>,
  options: FrameMentionOptions | undefined,
  frameCount: number,
  insertFrame: (frame: number) => void,
) => {
  const mention = useMention(
    viewRef,
    options === undefined
      ? undefined
      : {
          navigation: gridNavigation,
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
    createPlugin: mention.createPlugin,
    close: mention.close,
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
