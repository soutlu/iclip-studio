import { useEffect, useEffectEvent } from 'react'

// 开着的菜单、面板（Radix 用 popper 摆位置的那一类）；正在收起的不算，那时焦点可能还没还回去
const POPPED = '[data-radix-popper-content-wrapper] [data-state="open"]'

/**
 * 弹窗里有一件事要先用掉 Esc（收起展开的内容、取消拖动、取消选中……）时用：`active` 期间
 * 按 Esc 调 `onEscape`，弹窗这一下不关。
 * 焦点在弹出来的菜单或面板里时不抢：那一下归它自己关。
 */
export function useEscapeAheadOfDialog(active: boolean, onEscape: () => void) {
  const escape = useEffectEvent(onEscape)
  useEffect(() => {
    if (!active) return
    const claim = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (event.target instanceof Element && event.target.closest(POPPED) !== null) return
      event.preventDefault()
      escape()
    }
    window.addEventListener('keydown', claim, { capture: true })
    return () => window.removeEventListener('keydown', claim, { capture: true })
  }, [active])
}
