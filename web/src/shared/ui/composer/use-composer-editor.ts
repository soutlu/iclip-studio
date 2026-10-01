/** 编辑器处理键盘、粘贴、局部拖放与 NodeView；外层 window 或卡片接收其他区域的文件拖放。文档变化后同步附件引用，确保条目随文档回收。 */

import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Node as PMNode, Schema } from 'prosemirror-model'
import { EditorState, NodeSelection, Plugin, Selection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { parsePromptContent } from '@/shared/lib/prompt-clipboard'
import { filesWithoutDirectories } from '@/shared/ui/file-drop'
import type { ComposerNode, ErasedNodeSpec } from './composer-node'
import {
  collectAttachmentIds,
  composerNodeOf,
  createComposerSchema,
  isComposerEmpty,
} from './editor-schema'
import { composerParts } from './prompt-parts'
import type {
  ComposerAttachmentKind,
  ComposerAttachments,
  ComposerPart,
} from './use-composer-attachments'

/** 编辑器内部不区分使用方的节点类型，统一按 ComposerNode 处理。 */
type AnyPart = ComposerPart<ComposerNode>

/** 无名粘贴文件命名为 paste-<时间戳>.<扩展名>。 */
const renamePastedFile = (file: File): File =>
  file.name === ''
    ? new File([file], `paste-${Date.now()}.${file.type.split('/')[1] ?? 'png'}`, {
        type: file.type,
      })
    : file

/** NodeView 的宿主元素，React 内容经 portal 渲染进去。附件以 attId 为键；使用方节点每个视图一个键。 */
export type ComposerHost =
  | {
      readonly type: 'attachment'
      readonly key: string
      readonly el: HTMLElement
      readonly attId: string
      readonly kind: ComposerAttachmentKind
      readonly name: string
    }
  | {
      readonly type: 'node'
      readonly key: string
      readonly el: HTMLElement
      readonly node: ComposerNode
    }

/** 当前文档；`restored` 表示这次变化来自整篇恢复，不算用户的修改。 */
export type ComposerDocState = { readonly doc: PMNode; readonly restored: boolean }

const RESTORE_META = 'composer-restore'

type UseComposerEditorOptions = {
  /** 由 composer 持有，`@` 菜单内核也要读它。 */
  viewRef: RefObject<EditorView | null>
  attachments: ComposerAttachments
  attachmentsEnabled: boolean
  /** 新文件进编辑器之前过一遍，返回收下的那些（附件上限在这里截断）。 */
  admitFiles: (files: readonly File[]) => File[]
  /** 粘贴复制来的消息之前过一遍 parts（只收图片、附件上限在这里处理）。 */
  admitPasted: (parts: readonly AnyPart[]) => AnyPart[]
  canSend: () => boolean
  /** 选中上传失败的附件按 Enter 时调用，打开它的失败卡片。 */
  onOpenFailedAttachment: (attId: string) => void
  onSubmit: () => void
  registerHost: (host: ComposerHost) => void
  unregisterHost: (key: string) => void
  /** 以下只在挂载时读：两个页面各自使用固定的编辑器形态与节点。 */
  dense: boolean
  ariaLabel: string
  nodes: readonly ErasedNodeSpec[]
  /** 排在 Enter 处理之前的插件（`@` 菜单要先接 Enter 与方向键）。 */
  plugins: () => readonly Plugin[]
}

let nodeViewSeq = 0

/** 编辑器随宿主创建；变化中的数据和回调通过 ref 读取，避免重建实例。 */
export const useComposerEditor = ({
  admitFiles,
  admitPasted,
  ariaLabel,
  attachments,
  attachmentsEnabled,
  canSend,
  dense,
  nodes,
  onOpenFailedAttachment,
  onSubmit,
  plugins,
  registerHost,
  unregisterHost,
  viewRef,
}: UseComposerEditorOptions) => {
  // 节点 spec 是模块级常量，schema 在首次渲染时定下，之后不随 props 变。
  const [schema] = useState<Schema>(() => createComposerSchema(nodes))
  const [docState, setDocState] = useState<ComposerDocState>(() => ({
    doc: schema.node('doc', null, [schema.node('paragraph')]),
    restored: false,
  }))

  // 编辑器只建一次，变化中的回调与状态经 ref 读最新值；在提交阶段同步，
  // 保证 Enter 的发送门控与已渲染的发送按钮状态一致，不留可用却发不出去的空档。
  const latestRef = useRef({
    admitFiles,
    admitPasted,
    attachments,
    attachmentsEnabled,
    canSend,
    onOpenFailedAttachment,
    onSubmit,
    registerHost,
    unregisterHost,
  })
  useLayoutEffect(() => {
    latestRef.current = {
      admitFiles,
      admitPasted,
      attachments,
      attachmentsEnabled,
      canSend,
      onOpenFailedAttachment,
      onSubmit,
      registerHost,
      unregisterHost,
    }
  })

  const nodeType = (name: string) => {
    const type = schema.nodes[name]
    if (type === undefined) throw new Error(`composer schema 里没有 ${name} 节点`)
    return type
  }

  /** parts 落成 PM 行内节点；空文字段跳过，schema 不接受空文本节点。 */
  const nodesOf = (parts: readonly AnyPart[]): PMNode[] =>
    parts.flatMap((part) => {
      if (part.kind === 'text') return part.text === '' ? [] : [schema.text(part.text)]
      if (part.kind === 'media') {
        return [
          nodeType('attachment').create({
            attId: part.media.attId,
            kind: part.media.kind,
            name: part.media.name,
          }),
        ]
      }
      return [nodeType(part.node.name).create(part.node.attrs)]
    })

  const mediaOf = (parts: readonly AnyPart[]) =>
    parts.flatMap((part) => (part.kind === 'media' ? [part.media] : []))

  /** 插入后光标置于 pill 之后；位置不合法时回退文末。 */
  const insertNodeAt = (view: EditorView, node: PMNode, pos: number) => {
    const insert = (at: number) => {
      const tr = view.state.tr.insert(at, node)
      tr.setSelection(Selection.near(tr.doc.resolve(at + node.nodeSize))).scrollIntoView()
      view.dispatch(tr)
      return at + node.nodeSize
    }
    try {
      return insert(pos)
    } catch {
      return insert(Math.max(1, view.state.doc.content.size - 1))
    }
  }

  /** 上传并插入附件；未指定 pos 时使用当前选区。 */
  const insertFiles = (files: readonly File[], pos?: number) => {
    const view = viewRef.current
    if (view === null) return
    let at = pos ?? view.state.selection.to
    for (const raw of latestRef.current.admitFiles(files)) {
      const file = renamePastedFile(raw)
      const entry = latestRef.current.attachments.mintEntry(file)
      at = insertNodeAt(
        view,
        nodeType('attachment').create({ attId: entry.attId, kind: entry.kind, name: entry.name }),
        at,
      )
    }
    view.focus()
  }

  /** 在光标处按 parts 顺序插入正文、附件与使用方节点，替换选区。 */
  const insertParts = (parts: readonly AnyPart[]) => {
    const view = viewRef.current
    if (view === null) return
    const content = nodesOf(parts)
    if (content.length === 0) return
    latestRef.current.attachments.restoreEntries(mediaOf(parts))
    const insert = (from: number, to: number) => {
      const tr = view.state.tr.replaceWith(from, to, content)
      // 映射选区的终点：替换掉一段选区（如 `@查询词`）时起点会映射到插入内容之前，终点才落在它之后。
      tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(to)))).scrollIntoView()
      view.dispatch(tr)
    }
    const { from, to } = view.state.selection
    try {
      insert(from, to)
    } catch {
      const end = Math.max(1, view.state.doc.content.size - 1)
      insert(end, end)
    }
    view.focus()
  }

  /** 清空文档后由 syncReferences 回收附件条目。 */
  const clearDoc = () => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, nodeType('paragraph').create()),
    )
  }

  /** 按原始 parts 顺序恢复正文、附件与使用方节点；这次变化标成恢复。 */
  const restoreDoc = (parts: readonly AnyPart[]) => {
    const view = viewRef.current
    if (view === null) return
    latestRef.current.attachments.restoreEntries(mediaOf(parts))
    view.dispatch(
      view.state.tr
        .replaceWith(
          0,
          view.state.doc.content.size,
          nodeType('paragraph').create(null, nodesOf(parts)),
        )
        .setMeta(RESTORE_META, true),
    )
  }

  /** 删掉引用该附件的所有节点，条目随后由 syncReferences 回收；焦点留在编辑器。 */
  const removeAttachment = (attId: string) => {
    const view = viewRef.current
    if (view === null) return
    const positions: number[] = []
    view.state.doc.descendants((node, pos) => {
      if (node.type === nodeType('attachment') && node.attrs['attId'] === attId) positions.push(pos)
      return true
    })
    if (positions.length === 0) return
    const tr = view.state.tr
    // 从后往前删，前面的位置不受影响。
    for (const pos of positions.toReversed()) tr.delete(pos, pos + 1)
    view.dispatch(tr)
    view.focus()
  }

  const focusEditor = () => viewRef.current?.focus()

  // PM 粘贴处理器经 ref 调用最新 insertFiles，外层拖放复用同一操作。
  const insertFilesRef = useRef(insertFiles)
  const insertPartsRef = useRef(insertParts)
  useEffect(() => {
    insertFilesRef.current = insertFiles
    insertPartsRef.current = insertParts
  })

  // 以下只在挂载时读。
  const mountOptionsRef = useRef({ ariaLabel, dense, nodes, plugins })

  /** React 19 回调 ref 创建编辑器并返回清理函数，使实例生命周期与宿主元素一致。 */
  const mountEditor = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null) return undefined
      const mount = mountOptionsRef.current
      const attachmentType = schema.nodes['attachment']

      /** Enter 发送、Shift+Enter 换行、选中失败附件按 Enter 开失败卡片。写成插件排在 `@` 菜单之后：
       * PM 先跑 EditorView 自己的 props 再跑插件，放在 props 里会抢在菜单前面把 Enter 当发送。 */
      const enterPlugin = new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'Enter' || event.isComposing) return false
            const { selection } = view.state
            if (
              !event.shiftKey &&
              selection instanceof NodeSelection &&
              selection.node.type === attachmentType
            ) {
              const attId = selection.node.attrs['attId'] as string
              if (latestRef.current.attachments.entries.get(attId)?.status === 'error') {
                latestRef.current.onOpenFailedAttachment(attId)
                return true
              }
            }
            if (event.shiftKey) {
              view.dispatch(view.state.tr.insertText('\n').scrollIntoView())
              return true
            }
            // 内容不可发送时 Enter 仍不插入换行。
            if (latestRef.current.canSend()) latestRef.current.onSubmit()
            return true
          },
        },
      })

      const customViews = Object.fromEntries(
        mount.nodes.map((spec) => [
          spec.name,
          (node: PMNode) => {
            const span = document.createElement('span')
            span.className = 'composer-node'
            span.dataset['composerNode'] = spec.name
            nodeViewSeq += 1
            const key = `node-${nodeViewSeq}`
            latestRef.current.registerHost({
              el: span,
              key,
              node: composerNodeOf(node),
              type: 'node',
            })
            return {
              destroy: () => latestRef.current.unregisterHost(key),
              dom: span,
              // 原子节点的 attrs 不变；变了就重建视图。
              update: (next: PMNode) => next.type === node.type && next.sameMarkup(node),
            }
          },
        ]),
      )

      const view = new EditorView(el, {
        attributes: {
          'aria-label': mount.ariaLabel,
          'aria-multiline': 'true',
          class: mount.dense ? 'composer-editor composer-editor-dense' : 'composer-editor',
          role: 'textbox',
        },
        dispatchTransaction(tr) {
          const next = view.state.apply(tr)
          view.updateState(next)
          if (!tr.docChanged) return
          latestRef.current.attachments.syncReferences(collectAttachmentIds(next.doc))
          setDocState({ doc: next.doc, restored: tr.getMeta(RESTORE_META) === true })
        },
        handlePaste(_view, event) {
          if (!latestRef.current.attachmentsEnabled) return false
          const files = [...(event.clipboardData?.files ?? [])]
          if (files.length > 0) {
            event.preventDefault()
            insertFilesRef.current(files)
            return true
          }
          // 从气泡复制来的消息原样还原正文与附件；认不出就交还给 PM 当普通文字粘。
          const content = parsePromptContent(event.clipboardData?.getData('text/plain') ?? '')
          if (content === null) return false
          event.preventDefault()
          insertPartsRef.current(latestRef.current.admitPasted(composerParts(content)))
          return true
        },
        handleDrop(view, event) {
          if (!latestRef.current.attachmentsEnabled) return false
          const { dataTransfer } = event
          if (dataTransfer?.types.includes('Files') !== true) return false
          event.preventDefault()
          const files = filesWithoutDirectories(dataTransfer)
          if (files.length > 0) {
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            insertFilesRef.current(files, pos)
          }
          return true
        },
        nodeViews: {
          ...customViews,
          attachment(node) {
            const attId = node.attrs['attId'] as string
            const kind = node.attrs['kind'] as ComposerAttachmentKind
            const name = node.attrs['name'] as string
            const span = document.createElement('span')
            span.className = `media-chip attachment-pill attachment-${kind}`
            span.dataset['attachmentId'] = attId
            span.dataset['attachmentKind'] = kind
            span.dataset['attachmentName'] = name
            latestRef.current.registerHost({
              attId,
              el: span,
              key: attId,
              kind,
              name,
              type: 'attachment',
            })
            return {
              destroy() {
                latestRef.current.unregisterHost(attId)
              },
              dom: span,
              update: (next) => next.attrs['attId'] === attId,
            }
          },
        },
        state: EditorState.create({
          plugins: [
            ...mount.plugins(),
            enterPlugin,
            history(),
            keymap({ 'Mod-y': redo, 'Mod-z': undo, 'Shift-Mod-z': redo }),
            keymap(baseKeymap),
          ],
          schema,
        }),
      })
      viewRef.current = view
      return () => {
        view.destroy()
        viewRef.current = null
      }
    },
    [schema, viewRef],
  )

  const attIds = useMemo(() => collectAttachmentIds(docState.doc), [docState.doc])
  const empty = useMemo(() => isComposerEmpty(docState.doc), [docState.doc])

  return {
    attIds,
    clearDoc,
    docState,
    empty,
    focusEditor,
    insertFiles,
    insertParts,
    mountEditor,
    removeAttachment,
    restoreDoc,
  }
}
