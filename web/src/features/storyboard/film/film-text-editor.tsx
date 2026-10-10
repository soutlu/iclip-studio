/** 制作页上的一段字：shared 的编辑核心加帧节点，字里的 `@ImageN` 读进来是图片芯片（`FILM_FRAME_NODES`），
 * 写回时还原成原来的记号；芯片要的这组图与点击经 `FilmFrameChipsProvider` 现取，由使用方包在外面。
 * 这里不提供插入图片的入口，也没有 `@` 选图；删掉芯片照样交出去，图号对不上由保存时的检查拒绝。
 * 往字里贴图只提示贴到画面上。受控字符串，每行一个段落；`singleLine` 的（台词）Enter 不换行，粘贴的多行并成一行。 */

import { Plugin } from 'prosemirror-state'
import { Slice } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { useEffect, useEffectEvent, useRef } from 'react'
import { cn } from '@/shared/lib/utils'
import { toast } from '@/shared/ui/toast'
import {
  ComposerNodeViews,
  useAttachmentAdmission,
  useComposerAttachments,
  useComposerEditor,
} from '@/shared/ui/composer'
import { FILM_FRAME_NODES, filmPromptDoc } from './film-frame-node'

const { docToPrompt, promptToDoc } = filmPromptDoc

const pastedText = (singleLine: boolean) => (text: string) => {
  const doc = promptToDoc(singleLine ? text.replace(/\s*\n\s*/g, ' ') : text)
  return new Slice(doc.content, 1, 1)
}

/** 字里不收图：粘贴进来的图片不落进正文，提示贴到舞台的画面上换图。排在编辑核心的粘贴处理之前。 */
const imagePasteHintPlugin = () =>
  new Plugin({
    props: {
      handlePaste: (_view, event) => {
        if ((event.clipboardData?.files.length ?? 0) === 0) return false
        toast.info('文字中无法粘贴图片；请将图片粘贴到画面上')
        return true
      },
    },
  })

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
    initialDoc: () => promptToDoc(value),
    nodes: FILM_FRAME_NODES,
    onDocChange: (doc) => {
      const text = docToPrompt(doc)
      if (text === serializedRef.current) return
      serializedRef.current = text
      onChange(text)
    },
    plugins: () => [imagePasteHintPlugin(), ...(singleLine ? [singleLinePlugin()] : [])],
    readOnly,
    viewRef,
  })
  const { mountEditor, resetDoc } = editor

  // 外面换了这段字（AI 导演改了文件、冲突时用了最新的、选用机位图改了图号）：整篇重置文档与撤销历史。
  const resetTo = useEffectEvent((next: string) => {
    if (next === serializedRef.current) return
    serializedRef.current = next
    resetDoc(promptToDoc(next))
  })
  useEffect(() => resetTo(value), [value])

  return (
    <>
      <div className={cn('prompt-editor', className)} ref={mountEditor} />
      <ComposerNodeViews attachments={attachments} editor={editor} layerContainer={null} />
    </>
  )
}
