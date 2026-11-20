import { foldAll, foldedRanges, LanguageDescription, unfoldAll } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import type { FileKind } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { VIEWER, viewerLanguageFor } from './extensions'
import './source-editor.css'

export type SourceViewerHandle = {
  foldAll: () => void
  unfoldAll: () => void
}

type SourceViewerProps = {
  value: string
  kind: FileKind
  /** 按文件名挑语法高亮；挂载后再改不生效（换文件请换 `key`）。 */
  fileName: string
  ariaLabel: string
  /** 有没有折起来的段落：每次折叠状态变了都报一次。 */
  onFoldedChange?: (folded: boolean) => void
  ref?: Ref<SourceViewerHandle>
  className?: string
}

/**
 * 只读的原文查看器：行号、语法高亮、折叠，可以选中、复制和查找，不能改。
 * `value` 变了整篇换掉；`ref` 给「全部收起 / 全部展开」用。
 */
export function SourceViewer({
  ariaLabel,
  className,
  fileName,
  kind,
  onFoldedChange,
  ref,
  value,
}: SourceViewerProps) {
  const viewRef = useRef<EditorView | null>(null)
  const initialRef = useRef({ ariaLabel, fileName, kind, value })
  const onFoldedChangeRef = useRef(onFoldedChange)

  useLayoutEffect(() => {
    onFoldedChangeRef.current = onFoldedChange
  })

  useImperativeHandle(
    ref,
    () => ({
      foldAll: () => {
        if (viewRef.current !== null) foldAll(viewRef.current)
      },
      unfoldAll: () => {
        if (viewRef.current !== null) unfoldAll(viewRef.current)
      },
    }),
    [],
  )

  const mountViewer = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return
    const initial = initialRef.current
    const language = new Compartment()
    const found = viewerLanguageFor(initial.kind, initial.fileName)
    const pending = found instanceof LanguageDescription && found.support === undefined
    const ready = found instanceof LanguageDescription ? (found.support ?? []) : (found ?? [])
    const reportFolds = EditorView.updateListener.of((update) => {
      const folded = foldedRanges(update.state)
      if (folded !== foldedRanges(update.startState)) onFoldedChangeRef.current?.(folded.size > 0)
    })
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          VIEWER,
          language.of(ready),
          EditorView.contentAttributes.of({ 'aria-label': initial.ariaLabel }),
          initial.value.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [],
          reportFolds,
        ],
      }),
    })
    viewRef.current = view
    let alive = true
    if (pending) {
      void found.load().then((support) => {
        if (alive) view.dispatch({ effects: language.reconfigure(support) })
      })
    }
    return () => {
      alive = false
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.sliceDoc() === value) return
    view.dispatch({ changes: { from: 0, insert: value, to: view.state.doc.length } })
  }, [value])

  return <div className={cn('source-editor source-viewer min-h-0', className)} ref={mountViewer} />
}
