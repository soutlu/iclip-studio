import { baseKeymap } from 'prosemirror-commands'
import { closeHistory, history, redo, undo } from 'prosemirror-history'
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

type AnyPart = ComposerPart<ComposerNode>

const renamePastedFile = (file: File): File =>
  file.name === ''
    ? new File([file], `paste-${Date.now()}.${file.type.split('/')[1] ?? 'png'}`, {
        type: file.type,
      })
    : file

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

type ComposerDocState = { readonly doc: PMNode; readonly restored: boolean }

export type ComposerEnter =
  | { readonly kind: 'submit'; readonly canSend: () => boolean; readonly onSubmit: () => void }
  | { readonly kind: 'paragraph' }

type FailureCard = { readonly attId: string; readonly takeFocus: boolean }

const RESTORE_META = 'composer-restore'

type UseComposerEditorOptions = {
  viewRef: RefObject<EditorView | null>
  attachments: ComposerAttachments
  attachmentsEnabled: boolean
  admitFiles: (files: readonly File[]) => File[]
  admitPasted: ((parts: readonly AnyPart[]) => AnyPart[]) | undefined
  enter: ComposerEnter
  readOnly: boolean
  onDocChange?: ((doc: PMNode) => void) | undefined
  className: string
  ariaLabel: string
  nodes: readonly ErasedNodeSpec[]
  plugins: () => readonly Plugin[]
  initialDoc?: (() => PMNode) | undefined
  clipboardTextParser?: ((text: string) => Slice) | undefined
}

let nodeViewSeq = 0

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
  useLayoutEffect(() => {
    viewRef.current?.setProps({})
  }, [readOnly, viewRef])

  const nodeType = (name: string) => {
    const type = schema.nodes[name]
    if (type === undefined) throw new Error(`composer schema 里没有 ${name} 节点`)
    return type
  }

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

  const insertParts = (parts: readonly AnyPart[], position: 'selection' | 'end' = 'selection') => {
    const view = viewRef.current
    if (view === null) return
    const content = nodesOf(parts)
    if (content.length === 0) return
    latestRef.current.attachments.restoreEntries(mediaOf(parts))
    const insert = (from: number, to: number) => {
      const tr = view.state.tr.replaceWith(from, to, content)
      tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(to)))).scrollIntoView()
      view.dispatch(position === 'end' ? closeHistory(tr) : tr)
    }
    const end = Math.max(1, view.state.doc.content.size - 1)
    if (position === 'end') {
      insert(end, end)
      view.dispatch(closeHistory(view.state.tr))
    } else {
      const { from, to } = view.state.selection
      try {
        insert(from, to)
      } catch {
        insert(end, end)
      }
    }
    view.focus()
  }

  const clearDoc = () => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch(
      closeHistory(
        view.state.tr.replaceWith(0, view.state.doc.content.size, nodeType('paragraph').create()),
      ),
    )
    view.dispatch(closeHistory(view.state.tr))
  }

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

  const resetDoc = (doc: PMNode) => {
    const view = viewRef.current
    if (view === null) return
    view.updateState(EditorState.create({ doc, plugins: view.state.plugins }))
    latestRef.current.attachments.purgeExcept(collectAttachmentIds(doc))
    setFailureCard(null)
    setDocState({ doc, restored: true })
  }

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

  const replaceAttachment = (attId: string, parts: readonly AnyPart[]): Transaction | undefined => {
    const view = viewRef.current
    const pos = attachmentPosition(attId)
    if (view === null || pos === undefined) return undefined
    latestRef.current.attachments.restoreEntries(mediaOf(parts))
    return view.state.tr.replaceWith(pos, pos + 1, nodesOf(parts)).setMeta('addToHistory', false)
  }

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
    for (const pos of positions.toReversed()) tr.delete(pos, pos + 1)
    view.dispatch(tr)
    view.focus()
  }

  const focusEditor = () => viewRef.current?.focus()

  const insertFilesRef = useRef(insertFiles)
  const insertPartsRef = useRef(insertParts)
  useEffect(() => {
    insertFilesRef.current = insertFiles
    insertPartsRef.current = insertParts
  })

  const mountOptionsRef = useRef({
    ariaLabel,
    className,
    clipboardTextParser,
    doc: docState.doc,
    nodes,
    plugins,
  })

  const mountEditor = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null) return undefined
      const mount = mountOptionsRef.current
      const attachmentType = schema.nodes['attachment']

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
              update: (next: PMNode) => next.type === node.type && next.sameMarkup(node),
            }
          },
        ]),
      )

      const view = new EditorView(el, {
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
