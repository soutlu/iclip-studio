import type { Node as PMNode, NodeSpec } from 'prosemirror-model'
import { Schema } from 'prosemirror-model'
import type { ComposerNode, ErasedNodeSpec } from './composer-node'

const ATTACHMENT = 'attachment'

const baseNodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
  text: { group: 'inline' },
  [ATTACHMENT]: {
    attrs: {
      attId: {},
      kind: {},
      name: {},
    },
    atom: true,
    group: 'inline',
    inline: true,
    leafText: (node) => node.attrs['name'] as string,
    parseDOM: [
      {
        getAttrs: (dom) => ({
          attId: dom.getAttribute('data-attachment-id'),
          kind: dom.getAttribute('data-attachment-kind'),
          name: dom.getAttribute('data-attachment-name') ?? dom.textContent,
        }),
        tag: 'span.attachment-pill',
      },
    ],
    selectable: true,
    toDOM: (node) => [
      'span',
      {
        class: `attachment-pill attachment-${node.attrs['kind'] as string}`,
        'data-attachment-id': node.attrs['attId'] as string,
        'data-attachment-kind': node.attrs['kind'] as string,
        'data-attachment-name': node.attrs['name'] as string,
      },
      node.attrs['name'] as string,
    ],
  },
}

export const composerNodeOf = (node: PMNode): ComposerNode => ({
  attrs: node.attrs,
  name: node.type.name,
})

const parseNodeAttrs = (spec: ErasedNodeSpec, raw: string | null) => {
  if (raw === null) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const attrs: Record<string, string | number> = {}
  for (const attrName of spec.attrNames) {
    const value = (parsed as Record<string, unknown>)[attrName]
    if (typeof value !== 'string' && typeof value !== 'number') return false
    attrs[attrName] = value
  }
  return attrs
}

const customNodeSpec = (spec: ErasedNodeSpec): NodeSpec => ({
  attrs: Object.fromEntries(spec.attrNames.map((attrName) => [attrName, {}])),
  atom: true,
  group: 'inline',
  inline: true,
  leafText: (node) => spec.leafText(composerNodeOf(node)),
  parseDOM: [
    {
      getAttrs: (dom) => parseNodeAttrs(spec, dom.getAttribute('data-composer-attrs')),
      tag: `span[data-composer-node="${spec.name}"]`,
    },
  ],
  selectable: true,
  toDOM: (node) => [
    'span',
    {
      'data-composer-attrs': JSON.stringify(node.attrs),
      'data-composer-node': spec.name,
    },
    spec.leafText(composerNodeOf(node)),
  ],
})

const NO_NODES: readonly ErasedNodeSpec[] = []
const schemas = new WeakMap<readonly ErasedNodeSpec[], Schema>()

export const createComposerSchema = (nodes: readonly ErasedNodeSpec[] = NO_NODES): Schema => {
  const cached = schemas.get(nodes)
  if (cached !== undefined) return cached
  for (const spec of nodes) {
    if (spec.name in baseNodes) throw new Error(`composer 节点名 ${spec.name} 与内置节点重名`)
  }
  const schema = new Schema({
    nodes: {
      ...baseNodes,
      ...Object.fromEntries(nodes.map((spec) => [spec.name, customNodeSpec(spec)])),
    },
  })
  schemas.set(nodes, schema)
  return schema
}

const isAttachment = (node: PMNode) => node.type.name === ATTACHMENT

export const collectAttachmentIds = (doc: PMNode): string[] => {
  const ids: string[] = []
  doc.descendants((node) => {
    if (!isAttachment(node)) return true
    const attId = node.attrs['attId'] as string
    if (!ids.includes(attId)) ids.push(attId)
    return true
  })
  return ids
}

export type ComposerSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'attachment'; readonly attId: string }
  | { readonly kind: 'node'; readonly node: ComposerNode }

export const readComposerSegments = (doc: PMNode): ComposerSegment[] => {
  const segments: ComposerSegment[] = []
  let buffer = ''
  const flush = () => {
    if (buffer.length > 0) segments.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) buffer += '\n'
    paragraph.forEach((child) => {
      if (child.isText) {
        buffer += child.text ?? ''
        return
      }
      flush()
      segments.push(
        isAttachment(child)
          ? { attId: child.attrs['attId'] as string, kind: 'attachment' }
          : { kind: 'node', node: composerNodeOf(child) },
      )
    })
  })
  flush()
  const first = segments[0]
  if (first?.kind === 'text') segments[0] = { kind: 'text', text: first.text.trimStart() }
  const last = segments.at(-1)
  if (last?.kind === 'text')
    segments[segments.length - 1] = { kind: 'text', text: last.text.trimEnd() }
  return segments.filter((segment) => segment.kind !== 'text' || segment.text.length > 0)
}

export const readComposerText = (doc: PMNode): string =>
  doc.textBetween(0, doc.content.size, '\n', () => '')

export const isComposerEmpty = (doc: PMNode): boolean => {
  let empty = true
  doc.descendants((node) => {
    if (node.isText || (node.isInline && node.isAtom)) empty = false
    return empty
  })
  return empty
}
