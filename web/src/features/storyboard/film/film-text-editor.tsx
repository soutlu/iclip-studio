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

export const VIEW_LOCKED_TEXT = '机位图的引用随选用增删，无法删除或移动；请在镜头上取消选用'

const pastedText = (singleLine: boolean) => (text: string) => {
  const doc = promptToDoc(singleLine ? text.replace(/\s*\n\s*/g, ' ') : text)
  return new Slice(doc.content, 1, 1)
}

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

const singleLinePlugin = () =>
  new Plugin({
    props: {
      handleKeyDown: (_view, event) => event.key === 'Enter' && !event.isComposing,
    },
  })

const occurrences = (text: string, mark: string) =>
  text
    .split(mark)
    .slice(1)
    .filter((rest) => !/^\d/.test(rest)).length

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
  insert?: FilmTextInsert | undefined
  lockedLead?: string | undefined
  'aria-label': string
  className?: string
}

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

  const resetTo = useEffectEvent((next: string) => {
    if (next === serializedRef.current) return
    serializedRef.current = next
    resetDoc(promptToDoc(next))
  })
  useEffect(() => resetTo(value), [value])

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
