import { useLayoutEffect, type MouseEvent, type PointerEvent } from 'react'
import { razorSplit, splitAllAt, type Cut, type Links } from './clip-edit'
import type { FilmClip } from './composition/film'
import { useEditorRoot } from './editor-keys'
import { zoneOf } from './placement'
import { inLanes } from './timeline-lanes'

/**
 * 时间线上的切开工具（`razor` 为真时）：返回挂在各行上的处理函数（只在切开工具下挂上），换成切开工具时
 * 把丢到页面上的焦点交还编辑器的根节点。`timeAt` 把屏幕横坐标换成 final-cut 的时间，`onSplit` 切开这几处。
 */
export function useRazorLanes({
  razor,
  clips,
  links,
  timeAt,
  onSplit,
}: {
  razor: boolean
  clips: readonly FilmClip[]
  links: Links
  timeAt: (clientX: number) => number
  onSplit: (cuts: readonly Cut[]) => void
}) {
  // 换成切开工具时把手不画了：焦点原来在把手上的话随它丢到页面上，快捷键就收不到了，交还编辑器的根节点
  const editorRoot = useEditorRoot()
  useLayoutEffect(() => {
    if (razor && document.activeElement === document.body) editorRoot?.focus()
  }, [editorRoot, razor])
  /**
   * 剃刀下各行上的左键按下和点击在这里截住，不往片段、把手、框选那里传：按下就在那个时间切开，
   * 点击只吞掉（在片段上按 Enter 也不选中）。右键照常出菜单。
   */
  return {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !inLanes(event)) return
      event.stopPropagation()
      const at = timeAt(event.clientX)
      // 按指针所在的行和时间找片段，不按点中的元素：片段画出来比它的时长窄 2px，点在这道缝上也能切到那一刻的片段
      const lane =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-zone][data-track]')
          : null
      const clip = clips.find(
        (each) =>
          zoneOf(each) === lane?.dataset['zone'] &&
          String(each.track) === lane.dataset['track'] &&
          each.start <= at &&
          at < each.start + each.duration,
      )
      onSplit(
        event.shiftKey
          ? splitAllAt(at, clips, links)
          : clip === undefined
            ? []
            : razorSplit(clip, at, clips, links),
      )
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (inLanes(event)) event.stopPropagation()
    },
  }
}
