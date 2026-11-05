import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { ReactNode, Ref, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { useFileDropTarget, useWindowFileDrop } from '@/shared/ui/file-drop'
import type { ComposerNode, ComposerNodeSpec, ErasedNodeSpec } from './composer-node'
import { ComposerNodeViews, type ComposerAttachmentPreviewOf } from './composer-node-views'
import { ComposerNotice } from './composer-notice'
import { readComposerSegments, readComposerText } from './editor-schema'
import { selectMention, useMention, type CaretAnchor } from './mention'
import {
  DIRECTORY_NOTICE,
  useAttachmentAdmission,
  type ComposerAttachmentLimit,
} from './use-attachment-admission'
import { useComposerEditor } from './use-composer-editor'
import type {
  ComposerAccept,
  ComposerAttachment,
  ComposerPart,
  ComposerSubmission,
} from './use-composer-attachments'
import { useComposerAttachments } from './use-composer-attachments'

type AnyPart = ComposerPart<ComposerNode>

export type ComposerHandle<N extends ComposerNode = never> = {
  clear: () => void
  restore: (submission: ComposerSubmission<N>) => void
  insert: (parts: readonly ComposerPart<N>[]) => void
  append: (parts: readonly ComposerPart<N>[]) => void
  focus: () => void
  removeAttachment: (attId: string) => void
}

export type ComposerMentionMenu<Item> = {
  readonly items: readonly Item[]
  readonly query: string
  readonly active: number
  readonly anchor: RefObject<CaretAnchor>
  readonly listRef: (list: HTMLElement | null) => void
  readonly onPick: (index: number) => void
  readonly onClose: () => void
}

export type ComposerMention<Item, N extends ComposerNode = never> = {
  readonly items: (query: string) => readonly Item[]
  readonly partsOf: (item: Item) => readonly ComposerPart<N>[] | undefined
  readonly render: (menu: ComposerMentionMenu<Item>) => ReactNode
}

export type ComposerSubmitAction = {
  readonly label: string
  readonly pendingLabel: string
  readonly icon: IconName
  readonly emphasis: 'primary' | 'neutral'
  readonly disabled?: boolean
  readonly size?: 'md' | 'sm'
}

type ComposerToolbarClassNames = {
  readonly row?: string
  readonly leading?: string
  readonly trailing?: string
}

type ComposerProps<N extends ComposerNode, Item> = {
  onSubmit: (submission: ComposerSubmission<N>) => void
  placeholder?: string
  ariaLabel?: string
  leading?: ReactNode
  trailing?: ReactNode
  sending?: boolean
  dense?: boolean
  busy?: boolean
  onStop?: (() => void) | undefined
  attachmentsEnabled?: boolean
  accept?: ComposerAccept
  dropScope?: 'page' | 'card'
  attachmentLimit?: ComposerAttachmentLimit | undefined
  addControl?: ((openFilePicker: () => void) => ReactNode) | undefined
  submitAction?: ComposerSubmitAction | undefined
  toolbarClassNames?: ComposerToolbarClassNames | undefined
  nodes?: readonly ComposerNodeSpec<N>[]
  mention?: ComposerMention<Item, N> | undefined
  onChange?: ((parts: readonly ComposerPart<N>[]) => void) | undefined
  attachmentPreview?: ComposerAttachmentPreviewOf | undefined
  ref?: Ref<ComposerHandle<N>>
  className?: string
}

const partsOf = (
  doc: PMNode,
  entryOf: (attId: string) => ComposerAttachment | undefined,
): AnyPart[] => {
  const parts: AnyPart[] = []
  for (const segment of readComposerSegments(doc)) {
    if (segment.kind === 'attachment') {
      const entry = entryOf(segment.attId)
      if (entry !== undefined) parts.push({ kind: 'media', media: entry })
      continue
    }
    if (segment.kind === 'node') {
      parts.push(segment)
      continue
    }
    const previous = parts.at(-1)
    if (previous?.kind === 'text') {
      parts[parts.length - 1] = { kind: 'text', text: previous.text + segment.text }
    } else {
      parts.push(segment)
    }
  }
  return parts
}

const signatureOf = (parts: readonly AnyPart[]) =>
  JSON.stringify(
    parts.map((part) =>
      part.kind === 'media' ? [part.media.attId, part.media.status, part.media.url] : part,
    ),
  )

const NO_NODES: readonly ErasedNodeSpec[] = []

export function Composer<N extends ComposerNode = never, Item = never>({
  accept = 'media',
  addControl,
  ariaLabel = '输入消息',
  attachmentLimit,
  attachmentPreview,
  attachmentsEnabled = false,
  busy = false,
  className,
  dense = false,
  dropScope = 'page',
  leading,
  mention,
  nodes,
  onChange,
  onStop,
  onSubmit,
  placeholder = '输入消息，开始创作…',
  ref,
  sending = false,
  submitAction,
  toolbarClassNames,
  trailing,
}: ComposerProps<N, Item>) {
  const attachments = useComposerAttachments(accept)
  const admission = useAttachmentAdmission(accept, attachmentLimit)
  const { setNotice } = admission
  const viewRef = useRef<EditorView | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const mountRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    setRootEl(el)
  }, [])
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null)
  const nodeSpecs: readonly ErasedNodeSpec[] = nodes ?? NO_NODES

  const canSendNow = () => {
    if (sending || submitAction?.disabled === true || editor.empty) return false
    return !editor.attIds.some((attId) => attachments.entries.get(attId)?.status !== 'ready')
  }

  const submit = () => {
    const view = viewRef.current
    if (view === null || !canSendNow()) return
    const text = readComposerText(view.state.doc).trim()
    const media = attachments.takeReady(editor.attIds)
    const parts = partsOf(view.state.doc, (attId) => media.find((item) => item.attId === attId))
    onSubmit({ media, parts, text } as ComposerSubmission<N>)
  }

  const mentionCore = useMention(
    viewRef,
    mention === undefined
      ? undefined
      : {
          onPick: (index, { match, view }) => {
            const item = mention.items(match.query)[index]
            if (item === undefined) return
            const parts = mention.partsOf(item)
            if (parts === undefined) return
            selectMention(view)
            editorRef.current.insertParts(parts)
          },
          query: true,
        },
  )

  const editor = useComposerEditor({
    admitFiles: admission.admitFiles,
    admitPasted: admission.admitPasted,
    ariaLabel,
    attachments,
    attachmentsEnabled,
    className: dense ? 'composer-editor composer-editor-dense' : 'composer-editor',
    enter: { canSend: canSendNow, kind: 'submit', onSubmit: submit },
    nodes: nodeSpecs,
    plugins: () => [mentionCore.createPlugin()],
    readOnly: false,
    viewRef,
  })
  // 提前解构挂载回调，避免 react-hooks/refs 将 editor.mountEditor 误判为渲染期读取 ref。
  const { mountEditor } = editor

  const editorRef = useRef(editor)
  useEffect(() => {
    editorRef.current = editor
  })

  useImperativeHandle(
    ref,
    () => ({
      append: (parts) => editorRef.current.insertParts(parts, 'end'),
      clear: () => {
        setNotice(null)
        editorRef.current.clearDoc()
      },
      focus: () => editorRef.current.focusEditor(),
      insert: (parts) => editorRef.current.insertParts(parts),
      removeAttachment: (attId) => editorRef.current.removeAttachment(attId),
      restore: (submission) => {
        setNotice(null)
        editorRef.current.restoreDoc(submission.parts)
      },
    }),
    [setNotice],
  )

  const { docState } = editor
  const currentParts = useMemo(
    () => partsOf(docState.doc, (attId) => attachments.entries.get(attId)),
    [docState.doc, attachments.entries],
  )
  const signature = signatureOf(currentParts)
  const signatureRef = useRef(signature)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  useEffect(() => {
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    if (docState.restored) return
    onChangeRef.current?.(currentParts as readonly ComposerPart<N>[])
  }, [currentParts, docState.restored, signature])

  const pageDragOver = useWindowFileDrop({
    enabled: attachmentsEnabled && dropScope === 'page',
    onFiles: (files) => editorRef.current.insertFiles(files),
    ownRef: rootRef,
  })
  const cardDrop = useFileDropTarget({
    blocked: !attachmentsEnabled,
    onDirectory: () => setNotice(DIRECTORY_NOTICE),
    onFiles: (files) => editorRef.current.insertFiles(files),
  })
  const dragOver = dropScope === 'card' ? cardDrop.dragOver : pageDragOver

  const openFilePicker = () => fileInput?.click()
  const canSend = canSendNow()
  const mentionMenu = mentionCore.menu

  return (
    <>
      {busy && !editor.empty ? (
        <p className="px-3 pb-1.5 text-caption text-on-surface-faint">
          发送后将排队，本轮结束后执行
        </p>
      ) : null}
      <div
        className={cn(
          'composer-card relative rounded-xl border-[0.5px] border-chat-hairline bg-top-layer shadow-[var(--shadow-input)]',
          'transition-[border-color,box-shadow,background-color] ui-motion-m',
          'focus-within:border-border-hover',
          dragOver && 'border-on-surface',
          className,
        )}
        ref={mountRoot}
        {...(dropScope === 'card' ? cardDrop.dragHandlers : {})}
      >
        <div className="relative">
          <div ref={mountEditor} />
          {editor.empty ? (
            <div aria-hidden className="composer-placeholder-overlay">
              {placeholder}
            </div>
          ) : null}
        </div>
        {attachmentLimit !== undefined || dropScope === 'card' ? (
          <ComposerNotice notice={admission.notice} />
        ) : null}
        <div
          className={cn(
            'flex items-center justify-between gap-2 px-2 pt-1 pb-2',
            toolbarClassNames?.row,
          )}
        >
          <div className={cn('flex items-center gap-1', toolbarClassNames?.leading)}>
            {addControl !== undefined ? (
              addControl(openFilePicker)
            ) : attachmentsEnabled ? (
              <IconButton label="添加附件" name="add" onClick={openFilePicker} size="md" />
            ) : null}
            {leading}
          </div>
          <div className={cn('flex min-w-0 items-center gap-2', toolbarClassNames?.trailing)}>
            {trailing}
            {busy && onStop !== undefined ? (
              <button
                aria-label="停止"
                className={cn(
                  'grid size-(--control-height-md) ui-state cursor-pointer place-items-center rounded-full ui-focus',
                  'bg-surface-container-high text-on-surface hover:bg-inverse-surface hover:text-inverse-on-surface active:scale-95',
                )}
                onClick={onStop}
                type="button"
              >
                <Icon className="fill-current" decorative name="stop" size="sm" />
              </button>
            ) : null}
            {submitAction !== undefined ? (
              <Button
                className={cn(
                  'shrink-0 rounded-full',
                  submitAction.size === 'sm' &&
                    'h-(--control-height-sm) gap-1.5 px-2.5 text-label [&>svg]:size-(--icon-sm)',
                )}
                disabled={!canSend}
                leadingIcon={submitAction.icon}
                loading={sending}
                onClick={submit}
                size="md"
                variant={submitAction.emphasis === 'primary' ? 'primary' : 'tonal'}
              >
                {sending ? submitAction.pendingLabel : submitAction.label}
              </Button>
            ) : !busy || onStop === undefined || !editor.empty ? (
              <button
                aria-label="发送"
                className={cn(
                  'grid size-(--control-height-md) ui-state cursor-pointer place-items-center rounded-full ui-focus',
                  canSend
                    ? 'bg-inverse-surface text-inverse-on-surface shadow-[var(--shadow-send)] active:scale-95'
                    : 'bg-surface-container-high',
                )}
                disabled={!canSend}
                onClick={submit}
                type="button"
              >
                <Icon
                  className={cn(sending && 'animate-spin')}
                  decorative
                  name={sending ? 'loading' : 'send-up'}
                  size="md"
                />
              </button>
            ) : null}
          </div>
        </div>
        {attachmentsEnabled ? (
          <input
            accept={accept === 'image' ? MEDIA_IMAGE_ACCEPT : undefined}
            aria-hidden
            className="hidden"
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              if (files.length > 0) editorRef.current.insertFiles(files)
            }}
            ref={setFileInput}
            tabIndex={-1}
            type="file"
          />
        ) : null}
        <ComposerNodeViews
          attachmentPreview={attachmentPreview}
          attachments={attachments}
          editor={editor}
          layerContainer={rootEl}
        />
        {mention !== undefined && mentionMenu !== undefined
          ? mention.render({
              active: mentionMenu.active,
              anchor: mentionMenu.anchor,
              items: mention.items(mentionMenu.match.query),
              listRef: mentionMenu.listRef,
              onClose: mentionMenu.onClose,
              onPick: mentionMenu.pick,
              query: mentionMenu.match.query,
            })
          : null}
        {dragOver && dropScope === 'card' ? (
          <div
            aria-hidden
            className="composer-drop-overlay composer-drop-overlay-card animate-in duration-(--dur-s) fade-in"
            data-testid="composer-drop-overlay"
          >
            <div className="composer-drop-card">
              <Icon decorative name="add-file" size="md" />
              松开鼠标可添加附件
            </div>
          </div>
        ) : null}
        {dragOver && dropScope === 'page'
          ? createPortal(
              <div
                aria-hidden
                className="composer-drop-overlay layer-overlay animate-in duration-(--dur-s) fade-in"
                data-testid="composer-drop-overlay"
              >
                <div className="composer-drop-card">
                  <Icon decorative name="add-file" size="lg" />
                  松开鼠标可添加附件
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    </>
  )
}
