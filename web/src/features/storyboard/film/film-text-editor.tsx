/** 制作页上的一段字：shared 的编辑核心，只收纯文字，不收图片也没有 `@` 选图（图的编号由后端排，正文里不写）。
 * 受控字符串，每行一个段落；`singleLine` 的（台词）Enter 不换行，粘贴的多行并成一行。 */

import { Plugin } from 'prosemirror-state'
import { Slice, type Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { useEffect, useEffectEvent, useRef } from 'react'
import { cn } from '@/shared/lib/utils'
import {
  createComposerSchema,
  useAttachmentAdmission,
  useComposerAttachments,
  useComposerEditor,
} from '@/shared/ui/composer'

/** 不挂任何节点；schema 按这个数组建一次，文档与编辑器用的是同一个。 */
const NO_NODES = [] as const
const schema = createComposerSchema(NO_NODES)

const paragraph = (text: string) =>
  schema.node('paragraph', null, text === '' ? [] : [schema.text(text)])

const textToDoc = (text: string): PMNode =>
  schema.node('doc', null, text.split('\n').map(paragraph))

const docToText = (doc: PMNode): string => {
  const lines: string[] = []
  doc.forEach((node) => lines.push(node.textContent))
  return lines.join('\n')
}

const pastedText = (singleLine: boolean) => (text: string) => {
  const doc = textToDoc(singleLine ? text.replace(/\s*\n\s*/g, ' ') : text)
  return new Slice(doc.content, 1, 1)
}

/** 台词只有一行：Enter 什么也不做（Shift+Enter 也不换行）。排在编辑核心的 Enter 处理之前。 */
const singleLinePlugin = () =>
  new Plugin({
    props: {
      handleKeyDown: (_view, event) => event.key === 'Enter' && !event.isComposing,
    },
  })

type FilmTextEditorProps = {
  value: string
  onChange: (value: string) => void
  readOnly: boolean
  singleLine?: boolean
  'aria-label': string
  className?: string
}

export function FilmTextEditor({
  'aria-label': ariaLabel,
  className,
  onChange,
  readOnly,
  singleLine = false,
  value,
}: FilmTextEditorProps) {
  const viewRef = useRef<EditorView | null>(null)
  const attachments = useComposerAttachments('image')
  const admission = useAttachmentAdmission('image', undefined)
  // 最近交出去（或从外面收到）的字：外面带回同一段字时不重建文档，免得重置光标。
  const serializedRef = useRef(value)
  const editor = useComposerEditor({
    admitFiles: admission.admitFiles,
    admitPasted: undefined,
    ariaLabel,
    attachments,
    attachmentsEnabled: false,
    className: 'prompt-editor-content',
    clipboardTextParser: pastedText(singleLine),
    enter: { kind: 'paragraph' },
    initialDoc: () => textToDoc(value),
    nodes: NO_NODES,
    onDocChange: (doc) => {
      const text = docToText(doc)
      if (text === serializedRef.current) return
      serializedRef.current = text
      onChange(text)
    },
    plugins: () => (singleLine ? [singleLinePlugin()] : []),
    readOnly,
    viewRef,
  })
  const { mountEditor, resetDoc } = editor

  // 外面换了这段字（AI 导演改了文件、冲突时用了最新的）：整篇重置文档与撤销历史。
  const resetTo = useEffectEvent((next: string) => {
    if (next === serializedRef.current) return
    serializedRef.current = next
    resetDoc(textToDoc(next))
  })
  useEffect(() => resetTo(value), [value])

  return <div className={cn('prompt-editor', className)} ref={mountEditor} />
}
