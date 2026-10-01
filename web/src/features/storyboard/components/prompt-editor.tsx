/** 分镜正文编辑器：shared 的编辑核心（不套 Composer 外壳）加帧节点，Enter 分段；只读与编辑共用实例，通过 readOnly 切换。
 * 受控字符串：帧节点保留原文记号，`@Image01` 这类写法原样往返（见 prompt-editor-doc）。可编辑时敲 `@` 弹出本组图片（见 `useFrameMention`）。
 *
 * 粘贴、拖放与选择器上传的图片都落成附件 chip，上传中、失败重试与首页同一套；传好后把地址追加进本组，chip 换成 `@ImageN`。 */

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
  /** 把选区（`@` 选图的「+」留下的是盖住那个 `@` 的选区）换成第 `n` 帧的引用。 */
  insertFrame: (n: number) => void
  /** 收图片：`selection` 换掉选区，`end` 接在正文末尾。 */
  insertFiles: (files: readonly File[], place: 'selection' | 'end') => void
  /** 在这段下面就地提示（如拖进来的是文件夹）。 */
  showNotice: (notice: string) => void
}

/** 这段里在途的图片：chip 张数（上传中与失败待处理的都算）与是否有正在上传的。 */
export type PendingImages = { count: number; uploading: boolean }

/** 正文里收图片要的：张数上限与传好之后怎么落进本组。 */
export type PromptImages = {
  /** 本组还能再放几张（已有的与各段在途的都扣掉）。 */
  remaining: () => number
  /** 一张图传好了：在 `insertion` 处插入它的引用并把地址追加进本组，返回它的编号；放不进时抛出原因。 */
  land: (url: string, insertion: PromptInsertion) => number
  onPendingChange: (pending: PendingImages) => void
}

type PromptEditorProps = {
  value: string
  ref?: Ref<PromptEditorHandle> | undefined
  /** 帧数组下标为编号减一。 */
  frames: readonly string[]
  /** 分镜画幅；帧缩略图加载前按它占位。 */
  aspectRatio: string
  highlighted?: number | undefined
  readOnly?: boolean
  onChange?: ((value: string) => void) | undefined
  onPickFrame?: ((n: number) => void) | undefined
  /** 敲 `@` 选图；不给时 `@` 就是普通字符。 */
  mention?: FrameMentionOptions | undefined
  /** 粘贴、拖放图片；不给时不收（没有上传权限）。 */
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
  // 句柄、选图与落图经 ref 取最新的编辑器操作；编辑器建好之前没有可做的。
  const editorRef = useRef<ComposerEditor | null>(null)
  const attachments = useComposerAttachments('image')
  const admission = useAttachmentAdmission(
    'image',
    images === undefined
      ? undefined
      : {
          notice: (dropped) => `${REFERENCE_LIMIT_TEXT}，这次有 ${dropped} 张没有添加`,
          remaining: images.remaining,
        },
  )
  const frameMention = useFrameMention(viewRef, mention, frames.length, (frame) =>
    editorRef.current?.insertParts([framePart(frame)]),
  )
  // 最近交出去（或从外面收到）的正文：外面带回同一段正文时不重建文档，免得重置光标。
  const serializedRef = useRef(value)
  const editor = useComposerEditor({
    admitFiles: admission.admitFiles,
    // 复制来的聊天消息不还原成附件，按纯文字粘。
    admitPasted: undefined,
    ariaLabel,
    attachments,
    attachmentsEnabled: images !== undefined && !readOnly,
    className: 'prompt-editor-content',
    clipboardTextParser: pastedText,
    enter: { kind: 'paragraph' },
    initialDoc: () => promptToDoc(value),
    nodes: FRAME_NODES,
    // 文档变了就交出正文；只有 chip 进出、正文没变时不交。
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
  // 先解构挂载回调，避免 react-hooks/refs 将 editor.mountEditor 误判为 ref 读取。
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

  // 外面改了这段正文（agent 写回分镜、回填历史提示词）：整篇重置文档与撤销历史。在途的 chip 跟着丢掉，
  // 条目回收后迟到的上传结果不再回填——图只落进发起时用户看到的那段正文，正文被换掉就作废，与舞台替换帧的规则一致。
  const resetTo = useEffectEvent((next: string) => {
    if (next === serializedRef.current) return
    serializedRef.current = next
    editorRef.current?.resetDoc(promptToDoc(next))
  })
  useEffect(() => resetTo(value), [value])

  // 就绪的 chip 换成帧引用：先在 chip 的位置把引用与地址一起写进本组，拿到编号再换节点。
  // 换完的正文先记下，外面带回来时就认得是自己交出去的，不会整篇重置把同段其他在途的 chip 冲掉。
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
