/** 编辑核心：处理键盘、粘贴、局部拖放与 NodeView，带外壳的 Composer 与不带外壳的分镜正文共用。外层 window、卡片或段落卡接收其他区域的文件拖放。
 * 附件条目不随文档回收（撤销、重做会把节点带回来），只在整篇重置时回收。NodeView 只建宿主元素，内容由 `ComposerNodeViews` 经 portal 渲染进去。 */

import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Node as PMNode, Schema, Slice } from 'prosemirror-model'
import { EditorState, NodeSelection, Plugin, Selection, type Transaction } from 'prosemirror-state'
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

/** 当前文档；`restored` 表示这次变化来自整篇恢复或重置，不算用户的修改。 */
type ComposerDocState = { readonly doc: PMNode; readonly restored: boolean }

/** Enter 的含义。`submit`：Enter 发送、Shift+Enter 换行，内容不可发送时 Enter 什么也不插；
 * `paragraph`：Enter 分段，交给 baseKeymap。两种都先认「选中失败附件按 Enter」打开它的失败卡片。 */
export type ComposerEnter =
  | { readonly kind: 'submit'; readonly canSend: () => boolean; readonly onSubmit: () => void }
  | { readonly kind: 'paragraph' }

/** 失败卡片同一时刻只开一张。键盘打开时焦点进卡片；点开时留在编辑器，
 * 否则从可编辑区移过去的焦点会被浏览器算作键盘焦点，鼠标操作也亮出焦点环。 */
type FailureCard = { readonly attId: string; readonly takeFocus: boolean }

const RESTORE_META = 'composer-restore'

type UseComposerEditorOptions = {
  /** 由使用方持有，`@` 菜单内核也要读它。 */
  viewRef: RefObject<EditorView | null>
  attachments: ComposerAttachments
  attachmentsEnabled: boolean
  /** 新文件进编辑器之前过一遍，返回收下的那些（附件上限在这里截断）。 */
  admitFiles: (files: readonly File[]) => File[]
  /** 粘贴从气泡复制来的消息时先过一遍 parts（只收图片、附件上限在这里处理）；
   * 不给就不认这种消息，粘贴的文字交给 `clipboardTextParser`。 */
  admitPasted: ((parts: readonly AnyPart[]) => AnyPart[]) | undefined
  enter: ComposerEnter
  /** 只读：不可编辑，但仍可聚焦（键盘与点击能落到这段上）。 */
  readOnly: boolean
  /** 用户改了文档，在派发事务时同步调用（整篇恢复与重置不算）。受控使用方靠它在下一次按键之前交出新值，
   * 不能等 effect：effect 里交出的更新排在下一次按键之后，迟到的旧值会把文档重置掉。 */
  onDocChange?: ((doc: PMNode) => void) | undefined
  /** 以下只在挂载时读：各使用方的编辑器形态与节点固定。 */
  className: string
  ariaLabel: string
  nodes: readonly ErasedNodeSpec[]
  /** 排在 Enter 处理之前的插件（`@` 菜单要先接 Enter 与方向键）。 */
  plugins: () => readonly Plugin[]
  /** 初始文档；须按 `createComposerSchema(nodes)` 建（同一组 spec 得到同一个 schema）。不给是一个空段落。 */
  initialDoc?: (() => PMNode) | undefined
  /** 纯文字粘贴怎么落成文档片段；不给用 ProseMirror 默认的按行分段。 */
  clipboardTextParser?: ((text: string) => Slice) | undefined
}

let nodeViewSeq = 0

/** 编辑器随宿主创建；变化中的数据和回调通过 ref 读取，避免重建实例。 */
export const useComposerEditor = ({
  admitFiles,
  admitPasted,
  ariaLabel,
  attachments,
  attachmentsEnabled,
  className,
  clipboardTextParser,
  enter,
  initialDoc,
  nodes,
  onDocChange,
  plugins,
  readOnly,
  viewRef,
}: UseComposerEditorOptions) => {
  // 节点 spec 是模块级常量，schema 在首次渲染时定下，之后不随 props 变。
  const [schema] = useState<Schema>(() => createComposerSchema(nodes))
  const [docState, setDocState] = useState<ComposerDocState>(() => ({
    doc: initialDoc?.() ?? schema.node('doc', null, [schema.node('paragraph')]),
    restored: false,
  }))
  const [hosts, setHosts] = useState<readonly ComposerHost[]>([])
  const [failureCard, setFailureCard] = useState<FailureCard | null>(null)
  const specByName = useMemo(() => new Map(nodes.map((spec) => [spec.name, spec])), [nodes])

  const registerHost = useCallback((host: ComposerHost) => {
    setHosts((prev) => [...prev.filter((item) => item.key !== host.key), host])
  }, [])
  const unregisterHost = useCallback((key: string) => {
    setHosts((prev) => prev.filter((item) => item.key !== key))
  }, [])

  // 编辑器只建一次，变化中的回调与状态经 ref 读最新值；在提交阶段同步，
  // 保证 Enter 的发送门控与已渲染的发送按钮状态一致，不留可用却发不出去的空档。
  const latestRef = useRef({
    admitFiles,
    admitPasted,
    attachments,
    attachmentsEnabled,
    enter,
    onDocChange,
    readOnly,
  })
  useLayoutEffect(() => {
    latestRef.current = {
      admitFiles,
      admitPasted,
      attachments,
      attachmentsEnabled,
      enter,
      onDocChange,
      readOnly,
    }
  })
  // 可编辑与只读属性由 view 的函数 props 现读；只读切换后让 view 重算一次。
  useLayoutEffect(() => {
    viewRef.current?.setProps({})
  }, [readOnly, viewRef])

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

  /** 清空文档（如发送之后）。这一步可撤销，附件条目随之留到卸载：撤销后内容连同附件一起回来，附件仍可发送。 */
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

  /** 整篇换成 `doc` 并清空撤销历史，光标回到开头；这次变化标成恢复。不在文档里的附件条目随即回收，
   * 回收后的上传结果迟到也不会写回（见 `useComposerAttachments` 的 patch）。 */
  const resetDoc = (doc: PMNode) => {
    const view = viewRef.current
    if (view === null) return
    view.updateState(EditorState.create({ doc, plugins: view.state.plugins }))
    // 撤销历史随新状态清空，不在新文档里的附件再也回不来，此时才回收它们的条目。
    latestRef.current.attachments.purgeExcept(collectAttachmentIds(doc))
    setFailureCard(null)
    setDocState({ doc, restored: true })
  }

  /** 引用该附件的第一个节点在文档里的位置；不在文档里时为 undefined。 */
  const attachmentPosition = (attId: string): number | undefined => {
    const view = viewRef.current
    if (view === null) return undefined
    let found: number | undefined
    view.state.doc.descendants((node, pos) => {
      if (found !== undefined) return false
      if (node.type === nodeType('attachment') && node.attrs['attId'] === attId) found = pos
      return true
    })
    return found
  }

  /** 把引用该附件的第一个节点换成 parts（如附件就绪后换成使用方节点），返回换好的事务、不派发：
   * 使用方先按事务后的文档定下别处的状态，再自己 dispatch。附件已不在文档里时为 undefined。
   *
   * 这是系统替换，事务不进撤销历史：撤销要回到用户粘贴之前（连同换上的节点一起撤掉），而不是复活一个数据已被
   * 使用方消费掉的附件节点。 */
  const replaceAttachment = (attId: string, parts: readonly AnyPart[]): Transaction | undefined => {
    const view = viewRef.current
    const pos = attachmentPosition(attId)
    if (view === null || pos === undefined) return undefined
    latestRef.current.attachments.restoreEntries(mediaOf(parts))
    return view.state.tr.replaceWith(pos, pos + 1, nodesOf(parts)).setMeta('addToHistory', false)
  }

  /** 删掉引用该附件的所有节点，焦点留在编辑器；条目留着，撤销还能把附件连同状态一起带回来。 */
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
  const mountOptionsRef = useRef({
    ariaLabel,
    className,
    clipboardTextParser,
    doc: docState.doc,
    nodes,
    plugins,
  })

  /** React 19 回调 ref 创建编辑器并返回清理函数，使实例生命周期与宿主元素一致。 */
  const mountEditor = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null) return undefined
      const mount = mountOptionsRef.current
      const attachmentType = schema.nodes['attachment']

      /** Enter 按模式发送或分段，选中失败附件按 Enter 开失败卡片。写成插件排在 `@` 菜单之后：
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
                setFailureCard({ attId, takeFocus: true })
                return true
              }
            }
            const mode = latestRef.current.enter
            if (mode.kind === 'paragraph') return false
            if (event.shiftKey) {
              view.dispatch(view.state.tr.insertText('\n').scrollIntoView())
              return true
            }
            // 内容不可发送时 Enter 仍不插入换行。
            if (mode.canSend()) mode.onSubmit()
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
            registerHost({ el: span, key, node: composerNodeOf(node), type: 'node' })
            return {
              destroy: () => unregisterHost(key),
              dom: span,
              ...(spec.stopEvent === undefined ? {} : { stopEvent: spec.stopEvent }),
              // 原子节点的 attrs 不变；变了就重建视图。
              update: (next: PMNode) => next.type === node.type && next.sameMarkup(node),
            }
          },
        ]),
      )

      const view = new EditorView(el, {
        // 只读时 contenteditable 关掉就不可聚焦了；给个 tabindex，键盘和点击仍能落到这段上。
        attributes: () => ({
          'aria-label': mount.ariaLabel,
          'aria-multiline': 'true',
          class: mount.className,
          role: 'textbox',
          ...(latestRef.current.readOnly ? { 'aria-readonly': 'true', tabindex: '0' } : {}),
        }),
        ...(mount.clipboardTextParser === undefined
          ? {}
          : { clipboardTextParser: mount.clipboardTextParser }),
        dispatchTransaction(tr) {
          const next = view.state.apply(tr)
          view.updateState(next)
          if (!tr.docChanged) return
          const restored = tr.getMeta(RESTORE_META) === true
          setDocState({ doc: next.doc, restored })
          if (!restored) latestRef.current.onDocChange?.(next.doc)
        },
        handlePaste(_view, event) {
          if (!latestRef.current.attachmentsEnabled) return false
          const files = [...(event.clipboardData?.files ?? [])]
          if (files.length > 0) {
            event.preventDefault()
            insertFilesRef.current(files)
            return true
          }
          // 从气泡复制来的消息原样还原正文与附件；不认这种消息或认不出就交还给 PM 当普通文字粘。
          const { admitPasted: admit } = latestRef.current
          if (admit === undefined) return false
          const content = parsePromptContent(event.clipboardData?.getData('text/plain') ?? '')
          if (content === null) return false
          event.preventDefault()
          insertPartsRef.current(admit(composerParts(content)))
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
            registerHost({ attId, el: span, key: attId, kind, name, type: 'attachment' })
            return {
              destroy() {
                unregisterHost(attId)
              },
              dom: span,
              update: (next) => next.attrs['attId'] === attId,
            }
          },
        },
        editable: () => !latestRef.current.readOnly,
        state: EditorState.create({
          doc: mount.doc,
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
    [registerHost, schema, unregisterHost, viewRef],
  )

  const attIds = useMemo(() => collectAttachmentIds(docState.doc), [docState.doc])
  const empty = useMemo(() => isComposerEmpty(docState.doc), [docState.doc])

  return {
    attachmentPosition,
    attIds,
    clearDoc,
    docState,
    empty,
    focusEditor,
    insertFiles,
    insertParts,
    mountEditor,
    /** NodeView 宿主与失败卡片，交给 `ComposerNodeViews` 渲染。 */
    nodeViews: {
      failureCard,
      hosts,
      setFailureCard,
      specOf: (name: string) => specByName.get(name),
    },
    removeAttachment,
    replaceAttachment,
    resetDoc,
    restoreDoc,
  }
}

export type ComposerEditor = ReturnType<typeof useComposerEditor>
