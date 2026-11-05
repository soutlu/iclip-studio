import { EditorState } from '@codemirror/state'
import { EditorView, placeholder as placeholderText } from '@codemirror/view'
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { FileKind } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { BASE, languageFor } from './extensions'
import './source-editor.css'

type SourceEditorProps = {
  value: string
  onChange: (text: string) => void
  kind: FileKind
  ariaLabel: string
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

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
