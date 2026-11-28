import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorRootContext, useEditorEscape } from './editor-keys'

/** 登记一件要用掉 Esc 的事。 */
function Escapable({ onEscape }: { onEscape: () => void }) {
  useEditorEscape(true, onEscape)
  return null
}

/** 登记了 Esc 的编辑器根节点，里面一个按钮（像浮层里的元素）；答复这个按钮。 */
const renderEditor = (onEscape: () => void) => {
  const root = document.createElement('div')
  document.body.append(root)
  render(
    <EditorRootContext value={root}>
      <Escapable onEscape={onEscape} />
    </EditorRootContext>,
    { container: root },
  )
  const button = document.createElement('button')
  button.textContent = '浮层里的按钮'
  root.append(button)
  return button
}

describe('useEditorEscape', () => {
  const removers: (() => void)[] = []
  afterEach(() => {
    for (const remove of removers.splice(0)) remove()
  })

  it('焦点在编辑器里按 Esc：调 onEscape', () => {
    const onEscape = vi.fn()
    const button = renderEditor(onEscape)
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('更早的监听为这一下 Esc 把按键的元素移出了页面（收起并卸掉了它所在的浮层）：不调 onEscape', () => {
    const onEscape = vi.fn()
    const button = renderEditor(onEscape)
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') button.remove()
    }
    document.addEventListener('keydown', dismiss, { capture: true })
    removers.push(() => document.removeEventListener('keydown', dismiss, { capture: true }))

    fireEvent.keyDown(button, { key: 'Escape' })
    expect(button.isConnected).toBe(false)
    expect(onEscape).not.toHaveBeenCalled()
  })
})
