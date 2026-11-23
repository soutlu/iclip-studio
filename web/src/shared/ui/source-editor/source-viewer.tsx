import {
  foldable,
  foldedRanges,
  foldEffect,
  LanguageDescription,
  unfoldAll,
} from '@codemirror/language'
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
  /** 用于匹配语法高亮的文件名；挂载后变更不生效（切换文件请更换 `key`）。 */
  fileName: string
  ariaLabel: string
  /** 折叠状态变更回调：每次折叠区间变化时通知当前是否存在已折叠区域。 */
  onFoldedChange?: (folded: boolean) => void
  ref?: Ref<SourceViewerHandle>
  className?: string
}

type Range = { from: number; to: number }

/** 按文档顺序查找 `[from, to)` 范围内的最外层可折叠区间（逻辑同 CodeMirror `foldAll`，限定在指定范围内）。 */
const outerRanges = (state: EditorState, from: number, to: number): Range[] => {
  const ranges: Range[] = []
  for (let pos = from; pos < to;) {
    const line = state.doc.lineAt(pos)
    const range = foldable(state, line.from, line.to)
    const inside = range !== null && range.to <= to
    if (inside) ranges.push(range)
    pos = (inside ? state.doc.lineAt(range.to) : line).to + 1
  }
  return ranges
}

/**
 * 全部收起：折叠所有最外层可折叠区间；若整篇仅含单个最外层节点（如 JSON 根节点或 HTML 的 `<html>`），
 * 则保留根节点并折叠其直接子级，避免整篇被收起为单行。
 */
const foldOutline = (view: EditorView) => {
  const { state } = view
  const outer = outerRanges(state, 0, state.doc.length)
  const [root] = outer
  const targets =
    outer.length === 1 && root !== undefined
      ? outerRanges(state, state.doc.lineAt(root.from).to + 1, root.to)
      : outer
  if (targets.length > 0) view.dispatch({ effects: targets.map((range) => foldEffect.of(range)) })
}

/**
 * 只读原文查看器：提供行号、语法高亮与代码折叠，支持选中、复制与查找，禁止编辑。
 * `value` 变更时全量替换文档内容；通过 `ref` 暴露「全部收起 / 全部展开」控制方法。
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
        if (viewRef.current !== null) foldOutline(viewRef.current)
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
