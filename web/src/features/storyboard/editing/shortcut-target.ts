import type { KeyboardEvent } from 'react'

/** 正在打字的地方：输入框、文本域与可编辑正文；range 滑块没有文字，不算 */
export const isTextEntry = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'range'))

/**
 * 编辑器的单键快捷键只在弹窗里、不在打字时生效；浮层（role="dialog"，挂在弹窗里也算）与挂在弹窗外的
 * 菜单都不算，标签页的方向键与空格留给标签页自己。事件要挂在弹窗本身上（currentTarget 是弹窗）。
 */
export const isShortcutTarget = (event: KeyboardEvent<HTMLElement>) =>
  event.target instanceof HTMLElement &&
  event.target.closest('[role="dialog"]') === event.currentTarget &&
  !isTextEntry(event.target) &&
  event.target.closest('[role="tab"]') === null
