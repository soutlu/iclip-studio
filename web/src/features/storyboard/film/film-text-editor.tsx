/** 制作页上的一段字：shared 的编辑核心加帧节点，字里的 `@ImageN` 读进来是图片芯片（`FILM_FRAME_NODES`），
 * 写回时还原成原来的记号；芯片要的这组图与点击经 `FilmFrameChipsProvider` 现取，由使用方包在外面。
 * 受控字符串，每行一个段落；`singleLine` 的（台词）Enter 不换行，粘贴的多行并成一行。
 *
 * 给了 `insert` 的段能插入图片，与分镜正文同一套做法：敲 `@` 向上弹出这组列表里的图，选一张插入它的编号；粘贴、拖入或从
 * 「+」上传的图先是附件 chip（上传中、失败重试与首页相同），传好换成芯片：地址就是列表里某张图的用那张的编号，否则是
 * 新插入的图（缩略图加「新」，保存后按后端给的编号显示）。芯片像普通字符一样删。没给 `insert` 的段（台词、共用的拍法
 * 与声音）粘贴的图不落进正文，提示贴到画面上换图。
 *
 * `lockedLead` 是镜头开头机位图的引用「参考@ImageN，」：它随选用增删，这里删不掉、挪不动——改动会让正文不再以它开头、
 * 或让它的编号多出一处的，编辑器不收，并提示去镜头上取消选用（ProseMirror 的 `filterTransaction`，经编辑核心的插件入口）。 */

import { Plugin } from 'prosemirror-state'
import { Slice } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { useEffect, useEffectEvent, useRef } from 'react'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import { toast } from '@/shared/ui/toast'
import {
  ComposerNodeViews,
  ComposerNotice,
  useAttachmentAdmission,
  useComposerAttachments,
  useComposerEditor,
  type ComposerEditor,
} from '@/shared/ui/composer'
import { gridNavigation, selectMention, useMention } from '@/shared/ui/composer/mention'
import { framePart } from '../components/frame-node'
import { MAX_REFERENCE_IMAGES, REFERENCE_LIMIT_TEXT } from '../shots'
import type { FilmGroup } from './film.api'
import { FILM_FRAME_NODES, filmPromptDoc, newImagePart } from './film-frame-node'
import { FilmMentionMenu } from './film-mention-menu'

const { docToPrompt, promptToDoc } = filmPromptDoc

/** 删或挪镜头开头机位图引用时的提示。 */
export const VIEW_LOCKED_TEXT = '机位图的引用随选用增删，无法删除或移动；请在镜头上取消选用'

const pastedText = (singleLine: boolean) => (text: string) => {
  const doc = promptToDoc(singleLine ? text.replace(/\s*\n\s*/g, ' ') : text)
  return new Slice(doc.content, 1, 1)
}

/** 这段不收图时（`refused()` 为真），粘贴进来的图片不落进正文，提示贴到舞台的画面上换图。排在编辑核心的粘贴处理之前。 */
const imagePasteHintPlugin = (refused: () => boolean) =>
  new Plugin({
    props: {
      handlePaste: (_view, event) => {
        if (!refused() || (event.clipboardData?.files.length ?? 0) === 0) return false
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

/** `text` 里写了几处 `mark`（如 `@Image8`），后面紧跟数字的（`@Image80`）不算。 */
const occurrences = (text: string, mark: string) =>
  text
    .split(mark)
    .slice(1)
    .filter((rest) => !/^\d/.test(rest)).length

/** 正文以 `lead()` 开头时，不收让它不再开头、或让它的编号多出一处的改动。整篇重置不走事务，不受它管。 */
const lockedLeadPlugin = (lead: () => string | undefined) =>
  new Plugin({
    filterTransaction: (tr, state) => {
      const cite = lead()
      if (!tr.docChanged || cite === undefined) return true
      const before = docToPrompt(state.doc).trimStart()
      if (!before.startsWith(cite)) return true
      const after = docToPrompt(tr.doc)
      const mark = cite.slice(cite.indexOf('@'), -1)
      if (after.trimStart().startsWith(cite) && occurrences(after, mark) === 1) return true
      toast.info(VIEW_LOCKED_TEXT, { id: VIEW_LOCKED_TEXT })
      return false
    },
  })

/** 能插入图片的段要的：这组的图（`@` 菜单与传好的图按地址认编号）、能不能上传，以及有没有图正在上传。 */
export type FilmTextInsert = {
  group: FilmGroup
  uploads: boolean
  onUploadingChange: (uploading: boolean) => void
}

type FilmTextEditorProps = {
  value: string
  onChange: (value: string) => void
  readOnly: boolean
  singleLine?: boolean
  /** 能插入图片时给；不给就不收图、没有 `@` 选图。 */
  insert?: FilmTextInsert | undefined
  /** 正文开头删不掉、挪不动的机位图引用，如「参考@Image8，」。 */
  lockedLead?: string | undefined
  'aria-label': string
  className?: string
}

/** `@` 菜单里列的图：这组参考图列表里有编号、又不是哪一镜机位图的。 */
const insertableFrames = (group: FilmGroup) => {
  const views = new Set(group.shots.flatMap((shot) => (shot.view === null ? [] : [shot.view])))
  return group.frames.filter((frame) => frame.number !== null && !views.has(frame.node))
}

export function FilmTextEditor({
  'aria-label': ariaLabel,
  className,
  insert,
  lockedLead,
  onChange,
  readOnly,
  singleLine = false,
  value,
}: FilmTextEditorProps) {
  const viewRef = useRef<EditorView | null>(null)
  const editorRef = useRef<ComposerEditor | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const insertable = insert !== undefined && !readOnly
  const uploads = insertable && insert.uploads
  // 插件在挂载时建一次，开头的引用与收不收图经 ref 取最新的。
  const latestRef = useRef({ lockedLead, uploads })
  useEffect(() => {
    latestRef.current = { lockedLead, uploads }
  })
  const listedCount = insert?.group.frames.filter((frame) => frame.number !== null).length ?? 0
  const attachments = useComposerAttachments('image')
  const admission = useAttachmentAdmission(
    'image',
    uploads
      ? {
          notice: (dropped) => `${REFERENCE_LIMIT_TEXT}，本次有 ${dropped} 张未添加`,
          remaining: () =>
            MAX_REFERENCE_IMAGES - listedCount - (editorRef.current?.attIds.length ?? 0),
        }
      : undefined,
  )
  const menuFrames = insert === undefined ? [] : insertableFrames(insert.group)
  const mention = useMention(
    viewRef,
    insertable
      ? {
          navigation: gridNavigation,
          /** 选图片把 `@` 换成它的编号；选「+」时选区留着盖住 `@`，传好的图落在那里。 */
          onPick: (index, { view }) => {
            selectMention(view)
            const frame = menuFrames[index]
            if (frame?.number != null) {
              editorRef.current?.insertParts([framePart(frame.number)])
              return
            }
            fileRef.current?.click()
          },
          query: false,
        }
      : undefined,
  )
  // 最近交出去（或从外面收到）的字：外面带回同一段字时不重建文档，免得重置光标。
  const serializedRef = useRef(value)
  const editor = useComposerEditor({
    admitFiles: admission.admitFiles,
    admitPasted: undefined,
    ariaLabel,
    attachments,
    attachmentsEnabled: uploads,
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
    plugins: () => [
      imagePasteHintPlugin(() => !latestRef.current.uploads),
      ...(singleLine ? [singleLinePlugin()] : []),
      lockedLeadPlugin(() => latestRef.current.lockedLead),
      mention.createPlugin(),
    ],
    readOnly,
    viewRef,
  })
  const { mountEditor, resetDoc } = editor
  useEffect(() => {
    editorRef.current = editor
  })

  // 外面换了这段字（AI 导演改了文件、冲突时用了最新的、保存后换成了实际编号）：整篇重置文档与撤销历史。在途的附件 chip
  // 跟着丢掉，迟到的上传结果不再回填。
  const resetTo = useEffectEvent((next: string) => {
    if (next === serializedRef.current) return
    serializedRef.current = next
    resetDoc(promptToDoc(next))
  })
  useEffect(() => resetTo(value), [value])

  // 传好的附件 chip 换成芯片：地址就是列表里某张图的用它的编号，否则是新插入的图。换不进去（落在了镜头开头的机位图引用
  // 前面）就删掉这枚 chip。换节点不进撤销历史（见 replaceAttachment）。
  const landImage = useEffectEvent((attId: string, url: string) => {
    const view = viewRef.current
    const current = editorRef.current
    if (view === null || current === null || insert === undefined) return
    const same = insert.group.frames.find((frame) => frame.number !== null && frame.url === url)
    const part = same?.number == null ? newImagePart(url) : framePart(same.number)
    const tr = current.replaceAttachment(attId, [part])
    if (tr !== undefined) view.dispatch(tr)
    if (current.attachmentPosition(attId) === undefined) return
    const removal = current.replaceAttachment(attId, [])
    if (removal !== undefined) view.dispatch(removal)
  })
  const { attIds } = editor
  useEffect(() => {
    for (const attId of attIds) {
      const entry = attachments.entries.get(attId)
      if (entry?.status === 'ready' && entry.url !== undefined) landImage(attId, entry.url)
    }
  }, [attIds, attachments.entries])

  const uploading = attIds.some((attId) => attachments.entries.get(attId)?.status === 'uploading')
  const reportUploading = useEffectEvent((busy: boolean) => insert?.onUploadingChange(busy))
  useEffect(() => {
    reportUploading(uploading)
    return () => reportUploading(false)
  }, [uploading])

  const closeMention = mention.close
  useEffect(() => {
    if (!insertable) closeMention()
  }, [closeMention, insertable])

  const { menu } = mention
  return (
    <>
      <div className={cn('prompt-editor', className)} ref={mountEditor} />
      <ComposerNodeViews attachments={attachments} editor={editor} layerContainer={null} />
      {uploads ? (
        <>
          <ComposerNotice notice={admission.notice} />
          <input
            accept="image/*"
            aria-hidden
            className="hidden"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])]
              event.currentTarget.value = ''
              const view = viewRef.current
              if (files.length === 0 || view === null) return
              // 选区还盖着敲出来的那个 `@`：先删掉它，传的图落在它原来的位置。
              if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection())
              editorRef.current?.insertFiles(files)
            }}
            ref={fileRef}
            tabIndex={-1}
            type="file"
          />
        </>
      ) : null}
      {menu === undefined || insert === undefined ? null : (
        <FilmMentionMenu
          active={menu.active}
          anchor={menu.anchor}
          frames={menuFrames}
          listRef={menu.listRef}
          onClose={menu.onClose}
          onPick={menu.pick}
          onUpload={uploads ? () => menu.pick(menuFrames.length) : undefined}
          ratio={aspectValueOf(insert.group.aspectRatio)}
        />
      )}
    </>
  )
}
