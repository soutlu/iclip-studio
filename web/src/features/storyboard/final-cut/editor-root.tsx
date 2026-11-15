import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { refuseFileDropProps } from '@/shared/ui/file-drop'
import { EditorRootContext } from './editor-keys'

/**
 * final-cut 编辑器的根节点。编辑器和工作台里的对话并排，所以快捷键和 Esc 只认焦点在根节点里面时按的键：
 * 根节点可以聚焦（点在空白处时焦点落在它上面），打开时不抢焦点；拖进来的文件它不收，免得落到对话的
 * 输入框里。
 *
 * `onKeyDown` 收到焦点在根节点里时按的键，在编辑器里的控件自己处理完之后（控件拦下不往外传的收不到）；
 * 是不是快捷键再用 `isEditorKeyTarget` 判断。
 */
export function EditorRoot({
  children,
  onKeyDown,
}: {
  children: ReactNode
  onKeyDown?: (event: KeyboardEvent) => void
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const keyDown = useEffectEvent((event: KeyboardEvent) => onKeyDown?.(event))
  // 挂在 document 上、按冒泡的先后排在最后：编辑器里的控件（React 的处理都在应用根节点上派发）先处理，
  // 和按在根节点上一样；只收按键的元素在根节点里的，挂到别处的菜单、提示里按的键不算
  useEffect(() => {
    if (root === null) return
    const listen = (event: KeyboardEvent) => {
      if (event.target instanceof Node && root.contains(event.target)) keyDown(event)
    }
    document.addEventListener('keydown', listen)
    return () => document.removeEventListener('keydown', listen)
  }, [root])
  // 焦点所在的控件被删掉（比如删掉选中的片段）时，浏览器把焦点丢到页面上，快捷键就收不到了：
  // 交还给根节点。焦点已经去了编辑器外面的别处时不管
  useEffect(() => {
    if (root === null) return
    let focused: Element | null = null
    const enter = (event: FocusEvent) => {
      focused = event.target instanceof Element ? event.target : null
    }
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) focused = null
    }
    const observer = new MutationObserver(() => {
      const lost = document.activeElement === null || document.activeElement === document.body
      if (focused !== null && !focused.isConnected && lost) root.focus()
    })
    root.addEventListener('focusin', enter)
    root.addEventListener('focusout', leave)
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      root.removeEventListener('focusin', enter)
      root.removeEventListener('focusout', leave)
      observer.disconnect()
    }
  }, [root])
  return (
    <div
      aria-label="final-cut 编辑器"
      className="wf-editor"
      data-final-cut-editor=""
      ref={setRoot}
      role="group"
      tabIndex={-1}
      {...refuseFileDropProps}
    >
      <EditorRootContext value={root}>{children}</EditorRootContext>
    </div>
  )
}
