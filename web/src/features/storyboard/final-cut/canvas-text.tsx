import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import type { TextEdit } from './canvas-text-edit'
import { useEditorEscape } from './editor-keys'
import type { PreviewControl, TextTarget } from './preview-player'

type CanvasTextProps = {
  edit: TextEdit
  target: TextTarget
  zoom: number
  controlRef: RefObject<PreviewControl | null>
  /** 改完了；`refocus` 时焦点回到画面上（回车、Esc），点到别处时不抢。 */
  onClose: (refocus: boolean) => void
  onGesture: (active: boolean) => void
  onNotice: (message: string) => void
}

/**
 * 原地改字的输入框：盖在预览里藏起来的那段文字上，回车或点到别处时写进去，Esc 放弃。能换行的（字幕）是多行框，
 * Shift+回车换行。不能改的只说明原因。
 */
export function CanvasText({
  edit,
  target,
  zoom,
  controlRef,
  onClose,
  onGesture,
  onNotice,
}: CanvasTextProps) {
  const { label, initial, pinned, multiline } = edit
  const [value, setValue] = useState(initial)
  const doneRef = useRef(false)
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  const close = (text: string | null, refocus: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    controlRef.current?.endText(text)
    onGesture(false)
    onClose(refocus)
  }
  const save = (refocus: boolean) => {
    // Esc 放弃以后输入框被拿掉时也会失去焦点，那一下不写
    if (doneRef.current) return
    if (value === initial) {
      close(null, refocus)
      return
    }
    edit.save(value)
    close(value, refocus)
  }

  const open = useEffectEvent(() => {
    if (pinned !== undefined) {
      onNotice(pinned)
      close(null, true)
      return
    }
    onGesture(true)
    inputRef.current?.focus()
    inputRef.current?.select()
  })
  useEffect(() => {
    open()
  }, [])

  useEditorEscape(true, () => close(null, true))

  if (pinned !== undefined) return null
  const { rect, fontSize } = target
  const props = {
    'aria-label': label,
    autoComplete: 'off',
    className: multiline ? 'wf-canvas-text is-multiline' : 'wf-canvas-text',
    onBlur: () => save(false),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(event.target.value),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // 输入法还在拼字时的回车是选字
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
      if (multiline && event.shiftKey) return
      event.preventDefault()
      save(true)
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => event.stopPropagation(),
    ref: inputRef,
    spellCheck: false,
    style: {
      left: rect.x * zoom,
      top: rect.y * zoom,
      minWidth: rect.width * zoom,
      // 字幕的框跟着行数长高
      ...(multiline ? { minHeight: rect.height * zoom } : { height: rect.height * zoom }),
      fontSize: fontSize * zoom,
    },
    value,
  }
  return multiline ? <textarea {...props} rows={1} /> : <input {...props} />
}
