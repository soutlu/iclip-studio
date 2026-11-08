import type { KeyboardEvent } from 'react'

export const isTextEntry = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'range'))

export const isShortcutTarget = (event: KeyboardEvent<HTMLElement>) =>
  event.target instanceof HTMLElement &&
  event.target.closest('[role="dialog"]') === event.currentTarget &&
  !isTextEntry(event.target) &&
  event.target.closest('[role="tab"]') === null
