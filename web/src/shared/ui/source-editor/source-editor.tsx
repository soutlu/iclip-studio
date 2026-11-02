/**
 * 原文编辑器：直接编辑文件原文（CodeMirror 6），进出都是字符串，交出的就是用户敲的字，不做解析后的重写。
 * 挂载沿用 composer 的做法：回调 ref 建 EditorView，变化中的回调走 ref，不重建实例。
 */

import { EditorState } from '@codemirror/state'
import { EditorView, placeholder as placeholderText } from '@codemirror/view'
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { FileKind } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { BASE, languageFor } from './extensions'
import './source-editor.css'

type SourceEditorProps = {
  /** 当前原文。与编辑器上次交出的值不同（恢复版本、换了编辑对象）时整篇替换，不进撤销历史。 */
  value: string
  /** 用户改了内容才调用，交出改后的全文；挂载、换值、移动光标都不调用。 */
  onChange: (text: string) => void
  /** 按文件类型选语法高亮与写法检查；text 不加语言。 */
  kind: FileKind
  ariaLabel: string
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

/** 建编辑器状态时用到的设置；任何一项变了都整篇换新状态。 */
type Settings = { ariaLabel: string; kind: FileKind; placeholder: string | undefined }

export function SourceEditor({
  ariaLabel,
  autoFocus = false,
  className,
  kind,
  onChange,
  placeholder,
  value,
}: SourceEditorProps) {
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const emittedRef = useRef(value)
  const settingsRef = useRef<Settings>({ ariaLabel, kind, placeholder })
  const autoFocusRef = useRef(autoFocus)

  useLayoutEffect(() => {
    onChangeRef.current = onChange
  })

  const createState = useCallback((doc: string, settings: Settings) => {
    const emit = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      const text = update.state.sliceDoc()
      emittedRef.current = text
      onChangeRef.current(text)
    })
    return EditorState.create({
      doc,
      extensions: [
        BASE,
        languageFor(settings.kind),
        EditorView.contentAttributes.of({ 'aria-label': settings.ariaLabel }),
        settings.placeholder === undefined ? [] : placeholderText(settings.placeholder),
        // CRLF 的文件按 CRLF 读写，交出的换行与原文一致。
        doc.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [],
        emit,
      ],
    })
  }, [])

  const mountEditor = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null) return
      const view = new EditorView({
        parent: el,
        state: createState(emittedRef.current, settingsRef.current),
      })
      viewRef.current = view
      if (autoFocusRef.current) view.focus()
      return () => {
        view.destroy()
        viewRef.current = null
      }
    },
    [createState],
  )

  // 外部换了内容（不是自己刚交出去的那份）或换了文件类型：整篇换成新的状态，撤销历史从这里重新开始。
  useLayoutEffect(() => {
    const view = viewRef.current
    const settings = { ariaLabel, kind, placeholder }
    const previous = settingsRef.current
    const sameSettings =
      previous.ariaLabel === ariaLabel &&
      previous.kind === kind &&
      previous.placeholder === placeholder
    if (view === null || (value === emittedRef.current && sameSettings)) return
    settingsRef.current = settings
    emittedRef.current = value
    view.setState(createState(value, settings))
  }, [ariaLabel, createState, kind, placeholder, value])

  return <div className={cn('source-editor min-h-0', className)} ref={mountEditor} />
}
