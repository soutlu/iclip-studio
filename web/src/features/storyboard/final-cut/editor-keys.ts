import { createContext, use, useEffect, useEffectEvent } from 'react'
import { isTextEntry } from '../editing/shortcut-target'

/** final-cut 编辑器的根节点（`EditorRoot` 提供）；还没挂上时是 null。 */
export const EditorRootContext = createContext<HTMLElement | null>(null)

/** 所在编辑器的根节点；还没挂上时是 null。 */
export const useEditorRoot = () => use(EditorRootContext)

// 开着的菜单、面板（Radix 用 popper 摆位置的那一类）；正在收起的不算，那时焦点可能还没还回去。
// 编辑器里弹出的对话框也一样，Esc 归它自己
const LAYERED =
  '[data-radix-popper-content-wrapper] [data-state="open"], [role="dialog"], [role="alertdialog"]'

// 已经被编辑器里某件事用掉的 Esc。不看 defaultPrevented：页面上的提示框等浮层在 document 上先收到
// Esc、收起自己时也会标记它，那不算编辑器里的事用掉了这一下
const claimed = new WeakSet<Event>()

/**
 * 根节点 `root` 里按的键算不算编辑器的快捷键：按键的元素不在编辑器里弹出的对话框里，不是正在输入
 * 文字，也不在页签上。
 */
export const isEditorKeyTarget = (event: KeyboardEvent, root: HTMLElement) =>
  event.target instanceof HTMLElement &&
  event.target.closest('[role="dialog"], [role="alertdialog"], [data-final-cut-editor]') === root &&
  !isTextEntry(event.target) &&
  event.target.closest('[role="tab"]') === null

/**
 * 编辑器里有一件事要先用掉 Esc（取消拖动、取消选中……）时用：`active` 期间焦点在编辑器里按 Esc，
 * 调 `onEscape`；同一下 Esc 只给先登记的那一件。焦点在编辑器里弹出的菜单、面板或对话框里时不抢：
 * 那一下归它自己关。焦点不在编辑器里时不管，不在 window 上抢。
 */
export function useEditorEscape(active: boolean, onEscape: () => void) {
  const root = useEditorRoot()
  const escape = useEffectEvent(onEscape)
  useEffect(() => {
    if (!active || root === null) return
    const claim = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || claimed.has(event)) return
      const layer = event.target instanceof Element ? event.target.closest(LAYERED) : null
      if (layer !== null && root.contains(layer)) return
      claimed.add(event)
      event.preventDefault()
      escape()
    }
    root.addEventListener('keydown', claim, { capture: true })
    return () => root.removeEventListener('keydown', claim, { capture: true })
  }, [active, root])
}
