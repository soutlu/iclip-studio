import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { handleUndoShortcut, type UndoHistory } from '../editing/undo-shortcut'
import type { CanvasNudge } from './canvas-overlay'
import { isEditorKeyTarget, onCanvasLayer } from './editor-keys'
import type { EditTool } from './editor-toolbar'

/** 快捷键要用到的编辑器状态和操作，各项的意思同编辑器里同名的那个。 */
type ShortcutCommands = {
  gesturing: boolean
  history: UndoHistory
  leaveMaterial: () => void
  insert: () => void
  runSoundAction: () => void
  togglePlay: () => void
  toggleMute: () => void
  toggleLoop: () => void
  toggleFullscreen: () => void
  selected: ReadonlySet<string>
  removeSelected: () => void
  selectAround: (side: 'left' | 'right') => void
  zoomToSelection: () => void
  splitAtPlayhead: () => void
  setTool: Dispatch<SetStateAction<EditTool>>
  canvasNudgeRef: RefObject<CanvasNudge | null>
  seek: (ms: number) => void
  total: number
  playheadNow: () => number
}

/**
 * 编辑器的键盘快捷键：每次渲染把按键处理挂到 `keysRef` 上（编辑器根节点 `root` 收到按键时调它），
 * 按 `commands` 里的操作撤销重做、加入选区、播放、切开、删除、缩放、挪播放头或画面上的片段。
 */
export function useEditorShortcuts(
  keysRef: RefObject<((event: KeyboardEvent) => void) | null>,
  root: HTMLElement | null,
  commands: ShortcutCommands,
) {
  const {
    gesturing,
    history,
    leaveMaterial,
    insert,
    runSoundAction,
    togglePlay,
    toggleMute,
    toggleLoop,
    toggleFullscreen,
    selected,
    removeSelected,
    selectAround,
    zoomToSelection,
    splitAtPlayhead,
    setTool,
    canvasNudgeRef,
    seek,
    total,
    playheadNow,
  } = commands
  const shortcut = (event: KeyboardEvent, editor: HTMLElement) => {
    if (event.defaultPrevented || !isEditorKeyTarget(event, editor)) return
    // 全屏模式下菜单挂载在编辑器容器内，菜单内按键交由菜单自身处理；「属性」内的滑杆、下拉、取色与开关同理。
    // 时间尺上的播放头滑杆不在此列，点击后仍允许全局快捷键生效
    if (
      event.target instanceof Element &&
      event.target.closest(
        '[role="menu"], [data-inspector] :is(input, [role="slider"], [role="switch"], [aria-haspopup])',
      ) !== null
    )
      return
    const { key } = event
    // 带 ⌘ / Ctrl 的只有 ⇧⌘B（分离音频或合并回视频），撤销重做在前面处理过
    if (event.metaKey || event.ctrlKey) {
      if (!event.shiftKey || event.altKey || key.toLowerCase() !== 'b') return
      event.preventDefault()
      if (!event.repeat) runSoundAction()
      return
    }
    if (key === ' ') {
      event.preventDefault()
      togglePlay()
      return
    }
    const letter = event.altKey ? '' : key.toLowerCase()
    const toggle =
      letter === 'm' && !event.shiftKey
        ? toggleMute
        : letter === 'l' && event.shiftKey
          ? toggleLoop
          : letter === 'f' && !event.shiftKey
            ? toggleFullscreen
            : undefined
    if (toggle !== undefined) {
      event.preventDefault()
      if (!event.repeat) toggle()
      return
    }
    if ((key === 'Delete' || key === 'Backspace') && selected.size > 0) {
      event.preventDefault()
      removeSelected()
      return
    }
    if ((key === '[' || key === ']') && !event.altKey) {
      event.preventDefault()
      selectAround(key === '[' ? 'left' : 'right')
      return
    }
    if (letter === 'z' && !event.shiftKey) {
      event.preventDefault()
      if (!event.repeat) zoomToSelection()
      return
    }
    // 切不开时 S 什么都不做，也照样占着这个键
    const command = event.shiftKey
      ? undefined
      : letter === 's'
        ? splitAtPlayhead
        : letter === 'b'
          ? () => setTool((current) => (current === 'razor' ? 'select' : 'razor'))
          : letter === 'v' || letter === 'a'
            ? () => setTool('select')
            : undefined
    if (command !== undefined) {
      event.preventDefault()
      if (!event.repeat) command()
      return
    }
    // 焦点在画面上时方向键挪画面上选中的片段；画面上没有选中的片段时照常挪播放头
    if (onCanvasLayer(event.target) && canvasNudgeRef.current?.(event) === true) {
      event.preventDefault()
      return
    }
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    if (event.target instanceof HTMLInputElement) return
    event.preventDefault()
    const stepMs = (key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1_000 : 100)
    seek(Math.min(total, Math.max(0, playheadNow() + stepMs)))
  }
  useEffect(() => {
    keysRef.current = (event) => {
      // 拖片段、框选进行中不接快捷键：这时撤销或删片段，松手会按改之前算好的位置写回去
      if (gesturing || root === null) return
      handleUndoShortcut(event, history, leaveMaterial)
      if (event.key === 'Enter' && event.target === root) {
        event.preventDefault()
        insert()
        return
      }
      shortcut(event, root)
    }
    return () => {
      keysRef.current = null
    }
  })
}
