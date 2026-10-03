/** 参考 Kimi composer；Enter 发送，Shift+Enter 换行，IME 组字不发送。文档中的附件必须全部就绪才可提交，允许纯附件内容。
 *
 * 首页、对话直接用默认形态；图片编辑等使用方通过可选 props 接入自定义行内节点、`@` 菜单、卡片内拖放、
 * 只收图片、附件上限、自定义添加入口与提交按钮。 */

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
import { ComposerNodeViews } from './composer-node-views'
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

/** 组件内部不区分使用方的节点类型；对外的 props 与句柄按 `N` 收窄。 */
type AnyPart = ComposerPart<ComposerNode>

export type ComposerHandle<N extends ComposerNode = never> = {
  clear: () => void
  /** 按 parts 顺序替换整篇内容，用于发送失败恢复、修改已发消息与草稿恢复；这次替换不触发 onChange。 */
  restore: (submission: ComposerSubmission<N>) => void
  /** 在光标处插入 parts，替换选区。不受附件上限约束，使用方自己把关。 */
  insert: (parts: readonly ComposerPart<N>[]) => void
  focus: () => void
}

/** `@` 菜单要渲染的东西。选项必须渲染成 `role="option"`，文档顺序与 `items` 一一对应（分组标题不带这个角色）；
 * 挂上 `listRef`，焦点留在编辑器里（按下不抢焦点），键盘由编辑器转过来，`active` 是键盘停在的项。 */
export type ComposerMentionMenu<Item> = {
  readonly items: readonly Item[]
  readonly query: string
  readonly active: number
  readonly anchor: RefObject<CaretAnchor>
  readonly listRef: (list: HTMLElement | null) => void
  readonly onPick: (index: number) => void
  readonly onClose: () => void
}

/** 正文里敲 `@` 打开的菜单：`@` 之后到光标前的字是查询词；选中一项把 `@` 与查询词换成它的 parts。 */
export type ComposerMention<Item, N extends ComposerNode = never> = {
  readonly items: (query: string) => readonly Item[]
  /** 选中后插入的 parts；为 undefined 表示这一项此刻不能选（如超了上限），菜单留着。 */
  readonly partsOf: (item: Item) => readonly ComposerPart<N>[] | undefined
  readonly render: (menu: ComposerMentionMenu<Item>) => ReactNode
}

/** 带文字的提交按钮，代替默认的圆形发送钮。 */
export type ComposerSubmitAction = {
  readonly label: string
  /** `sending` 时的文字。 */
  readonly pendingLabel: string
  readonly icon: IconName
  /** primary 用主色（生成）；neutral 退为灰底，让位给页面上别处的主操作。 */
  readonly emphasis: 'primary' | 'neutral'
}

type ComposerProps<N extends ComposerNode, Item> = {
  /** 回车或发送按钮触发；空内容和未就绪附件不提交。 */
  onSubmit: (submission: ComposerSubmission<N>) => void
  placeholder?: string
  /** 编辑区的可访问名。 */
  ariaLabel?: string
  /** 附件按钮之后的工具行内容。 */
  leading?: ReactNode
  /** 发送按钮之前的工具行内容。 */
  trailing?: ReactNode
  sending?: boolean
  /** dense 从单行起步，否则从三行起步。 */
  dense?: boolean
  /** 运行时替换为停止按钮，不受空输入的发送禁用条件影响。 */
  busy?: boolean
  onStop?: (() => void) | undefined
  /** 由调用方根据登录态与 uploads:write 决定上传入口是否可用。 */
  attachmentsEnabled?: boolean
  /** 收哪些媒体，默认图片与视频。 */
  accept?: ComposerAccept
  /** 文件拖放的接收范围：page 是整页兜底（页面上只能有一个），card 只收落在输入卡上的，提示也只盖住卡片。
   * 输入框在弹窗里时用 card。 */
  dropScope?: 'page' | 'card'
  attachmentLimit?: ComposerAttachmentLimit | undefined
  /** 代替默认的「添加附件」按钮；附件不可用时 `openFilePicker` 什么也不做。 */
  addControl?: ((openFilePicker: () => void) => ReactNode) | undefined
  submitAction?: ComposerSubmitAction | undefined
  /** 使用方自定义的行内节点；须是模块级常量，只在挂载时读。 */
  nodes?: readonly ComposerNodeSpec<N>[]
  mention?: ComposerMention<Item, N> | undefined
  /** 文档变化、附件状态或地址变化时触发（上传进度不算）；整篇恢复不触发。 */
  onChange?: ((parts: readonly ComposerPart<N>[]) => void) | undefined
  ref?: Ref<ComposerHandle<N>>
  className?: string
}

/** 按文档顺序把段落拼成 parts，相邻文字合并；取不到条目的附件不进 parts。 */
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

/** 判断 parts 有没有变：附件只看身份、状态与地址，进度不算。 */
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
  trailing,
}: ComposerProps<N, Item>) {
  const attachments = useComposerAttachments(accept)
  const admission = useAttachmentAdmission(accept, attachmentLimit)
  const { setNotice } = admission
  const viewRef = useRef<EditorView | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // 失败卡片与悬停预览卡挂在根节点上，渲染期要拿到元素本身，ref 只能在事件里读。
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const mountRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    setRootEl(el)
  }, [])
  // 存成 state：添加入口由使用方在渲染期拿到 openFilePicker，不能经 ref 读。
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null)
  const nodeSpecs: readonly ErasedNodeSpec[] = nodes ?? NO_NODES

  /** 只有内容非空且引用附件全部就绪才可发送；编辑器经 ref 获取最新判定闭包。 */
  const canSendNow = () => {
    if (sending || editor.empty) return false
    return !editor.attIds.some((attId) => attachments.entries.get(attId)?.status !== 'ready')
  }

  const submit = () => {
    const view = viewRef.current
    if (view === null || !canSendNow()) return
    const text = readComposerText(view.state.doc).trim()
    const media = attachments.takeReady(editor.attIds)
    const parts = partsOf(view.state.doc, (attId) => media.find((item) => item.attId === attId))
    // parts 里的节点来自 `nodes` 给的 spec，类型就是 N。
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
            // 选区盖住 `@` 与查询词，插入时整段换掉。
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
  // 先解构挂载回调，避免 react-hooks/refs 将 editor.mountEditor 误判为 ref 读取。
  const { mountEditor } = editor

  // 命令式句柄、拖放监听器与 `@` 菜单经 ref 获取最新编辑器操作。
  const editorRef = useRef(editor)
  useEffect(() => {
    editorRef.current = editor
  })

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        setNotice(null)
        editorRef.current.clearDoc()
      },
      focus: () => editorRef.current.focusEditor(),
      insert: (parts) => editorRef.current.insertParts(parts),
      restore: (submission) => {
        setNotice(null)
        editorRef.current.restoreDoc(submission.parts)
      },
    }),
    [setNotice],
  )

  // 文档或附件状态变了才通知使用方；挂载时的空文档与整篇恢复都不算。
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

  // 整页模式：聊天入口是页面的兜底接收者，别处拖放区接管的文件让出，正文里的 drop 由编辑器按落点插入。
  const pageDragOver = useWindowFileDrop({
    enabled: attachmentsEnabled && dropScope === 'page',
    onFiles: (files) => editorRef.current.insertFiles(files),
    ownRef: rootRef,
  })
  // 卡片模式：输入卡自己是局部拖放区；正文里的 drop 编辑器先收下，卡片见 defaultPrevented 就不再收。
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
      {/* 跑着时写了字才提示，放在卡片上方而不挤进控件行。卡片之前固定占一个子节点位，提示出没不重挂卡片；
          不传 busy 的使用方这里恒为 null，DOM 与之前一致。 */}
      {busy && !editor.empty ? (
        <p className="px-3 pb-1.5 text-caption text-on-surface-faint">发送后排队，这一轮结束再跑</p>
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
        {/* 只有会出提示的形态（有上限或卡片拖放）才挂播报区，播报区要先在才播得出后放进去的字。 */}
        {attachmentLimit !== undefined || dropScope === 'card' ? (
          <ComposerNotice notice={admission.notice} />
        ) : null}
        <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
          <div className="flex items-center gap-1">
            {addControl !== undefined ? (
              addControl(openFilePicker)
            ) : attachmentsEnabled ? (
              <IconButton label="添加附件" name="add" onClick={openFilePicker} size="md" />
            ) : null}
            {leading}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {trailing}
            {busy && onStop !== undefined ? (
              <button
                aria-label="停止"
                // 与发送钮同形的中性圆钮：只剩它时是本栏唯一的主操作，与发送并排时让位给墨色发送钮。
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
                className="shrink-0 rounded-full"
                disabled={!canSend}
                leadingIcon={submitAction.icon}
                loading={sending}
                onClick={submit}
                size="md"
                variant={submitAction.emphasis === 'primary' ? 'primary' : 'tonal'}
              >
                {sending ? submitAction.pendingLabel : submitAction.label}
              </Button>
            ) : // 跑着的时候输入框也能发：写了字就把发送钮亮出来，发出去的排队。空着时只留停止。
            !busy || onStop === undefined || !editor.empty ? (
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
              event.target.value = '' // 清空文件输入值，允许再次选择同一文件。
              if (files.length > 0) editorRef.current.insertFiles(files)
            }}
            ref={setFileInput}
            tabIndex={-1}
            type="file"
          />
        ) : null}
        <ComposerNodeViews attachments={attachments} editor={editor} layerContainer={rootEl} />
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
              松开鼠标添加附件
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
                  松开鼠标添加附件
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    </>
  )
}
