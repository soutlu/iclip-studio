import { Slice } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { useEffect, useEffectEvent, useImperativeHandle, useRef, type Ref } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import {
  ComposerNodeViews,
  ComposerNotice,
  useAttachmentAdmission,
  useComposerAttachments,
  useComposerEditor,
  type ComposerEditor,
} from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import type { PromptInsertion } from '../shot-document'
import { REFERENCE_LIMIT_TEXT } from '../shots'
import { FrameChipsProvider } from './frame-chip'
import { FrameMentionMenu } from './frame-mention-menu'
import { FRAME_NODES, framePart } from './frame-node'
import { docToPrompt, promptOffsetAt, promptToDoc } from './prompt-editor-doc'
import { useFrameMention, type FrameMentionOptions } from './use-frame-mention'

export type PromptEditorHandle = {
  insertFrame: (n: number) => void
  insertFiles: (files: readonly File[], place: 'selection' | 'end') => void
  showNotice: (notice: string) => void
}

export type PendingImages = { count: number; uploading: boolean }

export type PromptImages = {
  remaining: () => number
  land: (url: string, insertion: PromptInsertion) => number
  onPendingChange: (pending: PendingImages) => void
}

type PromptEditorProps = {
  value: string
  ref?: Ref<PromptEditorHandle> | undefined
  frames: readonly string[]
  aspectRatio: string
  highlighted?: number | undefined
  readOnly?: boolean
  onChange?: ((value: string) => void) | undefined
  onPickFrame?: ((n: number) => void) | undefined
  mention?: FrameMentionOptions | undefined
  images?: PromptImages | undefined
  'aria-label': string
  className?: string
}

const pastedText = (text: string) => new Slice(promptToDoc(text).content, 1, 1)

export function PromptEditor({
  'aria-label': ariaLabel,
  aspectRatio,
  className,
  frames,
  highlighted,
  images,
  mention,
  value,
  ref,
  onChange,
  onPickFrame,
  readOnly = false,
}: PromptEditorProps) {
  const viewRef = useRef<EditorView | null>(null)
  const editorRef = useRef<ComposerEditor | null>(null)
  const attachments = useComposerAttachments('image')
  const admission = useAttachmentAdmission(
    'image',
    images === undefined
      ? undefined
      : {
          notice: (dropped) => `${REFERENCE_LIMIT_TEXT}，本次有 ${dropped} 张未添加`,
          remaining: images.remaining,
        },
  )
  const frameMention = useFrameMention(viewRef, mention, frames.length, (frame) =>
    editorRef.current?.insertParts([framePart(frame)]),
  )
  const serializedRef = useRef(value)
  const editor = useComposerEditor({
    admitFiles: admission.admitFiles,
    admitPasted: undefined,
    ariaLabel,
    attachments,
    attachmentsEnabled: images !== undefined && !readOnly,
    className: 'prompt-editor-content',
    clipboardTextParser: pastedText,
    enter: { kind: 'paragraph' },
    initialDoc: () => promptToDoc(value),
    nodes: FRAME_NODES,
    onDocChange: (doc) => {
      const text = docToPrompt(doc)
      if (text === serializedRef.current) return
      serializedRef.current = text
      onChange?.(text)
    },
    plugins: () => [frameMention.createPlugin()],
    readOnly,
    viewRef,
  })
  // 提前解构挂载回调，避免 react-hooks/refs 将 editor.mountEditor 误判为渲染期读取 ref。
  const { mountEditor } = editor
  useEffect(() => {
    editorRef.current = editor
  })
  const { setNotice } = admission

  useImperativeHandle(
    ref,
    () => ({
      insertFiles: (files, place) => {
        const view = viewRef.current
        if (view === null) return
        if (place === 'end') {
          editorRef.current?.insertFiles(files, view.state.doc.content.size - 1)
          return
        }
        if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection())
        editorRef.current?.insertFiles(files)
      },
      insertFrame: (n) => editorRef.current?.insertParts([framePart(n)]),
      showNotice: setNotice,
    }),
    [setNotice],
  )

  const resetTo = useEffectEvent((next: string) => {
    if (next === serializedRef.current) return
    serializedRef.current = next
    editorRef.current?.resetDoc(promptToDoc(next))
  })
  useEffect(() => resetTo(value), [value])

  const landImage = useEffectEvent((attId: string, url: string) => {
    const view = viewRef.current
    const current = editorRef.current
    const pos = current?.attachmentPosition(attId)
    if (view === null || current === null || pos === undefined || images === undefined) return
    const { doc } = view.state
    const offset = promptOffsetAt(doc, pos)
    let n: number
    try {
      n = images.land(url, { end: offset, start: offset, text: docToPrompt(doc) })
    } catch (error) {
      toast.error(errorMessageOf(error, '添加图片失败'))
      const removal = current.replaceAttachment(attId, [])
      if (removal !== undefined) view.dispatch(removal)
      return
    }
    const tr = current.replaceAttachment(attId, [framePart(n)])
    if (tr === undefined) return
    serializedRef.current = docToPrompt(tr.doc)
    view.dispatch(tr)
  })
  const { attIds } = editor
  useEffect(() => {
    for (const attId of attIds) {
      const entry = attachments.entries.get(attId)
      if (entry?.status === 'ready' && entry.url !== undefined) landImage(attId, entry.url)
    }
  }, [attIds, attachments.entries])

  const pendingCount = attIds.length
  const uploading = attIds.some((attId) => attachments.entries.get(attId)?.status === 'uploading')
  const reportPending = useEffectEvent((pending: PendingImages) => images?.onPendingChange(pending))
  useEffect(() => {
    reportPending({ count: pendingCount, uploading })
    return () => reportPending({ count: 0, uploading: false })
  }, [pendingCount, uploading])

  const closeMention = frameMention.close
  useEffect(() => {
    if (readOnly) closeMention()
  }, [closeMention, readOnly])

  return (
    <>
      <div className={cn('prompt-editor', className)} ref={mountEditor} />
      <FrameChipsProvider value={{ frames, highlighted, onPick: (n) => onPickFrame?.(n) }}>
        <ComposerNodeViews attachments={attachments} editor={editor} layerContainer={null} />
      </FrameChipsProvider>
      {images === undefined ? null : <ComposerNotice notice={admission.notice} />}
      {frameMention.menu === undefined ? null : (
        <FrameMentionMenu
          {...frameMention.menu}
          frames={frames}
          ratio={aspectValueOf(aspectRatio)}
        />
      )}
    </>
  )
}
