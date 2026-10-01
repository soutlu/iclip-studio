/** 参考 Kimi schema：doc → paragraph → text | attachment | 使用方节点。附件与使用方节点都是可选中的 inline atom；
 * NodeView 渲染内容，toDOM / parseDOM 负责序列化。 */

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
    // 复制附件节点时使用可读文件名。
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

/** 节点 attrs 收进 ComposerNode；值只有字符串与数字两种。 */
export const composerNodeOf = (node: PMNode): ComposerNode => ({
  attrs: node.attrs,
  name: node.type.name,
})

/** 从复制出去的 HTML 认回节点：attrs 不是约定的那几个键、值不是字符串或数字就不认。 */
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

/** 按使用方的节点 spec 建 schema；同一组 spec（模块级常量）只建一次。 */
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

/** 按出现顺序收集去重后的附件 ID。 */
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

/** 按文档顺序保留文字、附件与使用方节点，避免失去相邻引用语义；段落以换行分隔并去除首尾空白。 */
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

/** 只提取用户文字，段落以换行连接；附件与使用方节点另按 parts 提交。 */
export const readComposerText = (doc: PMNode): string =>
  doc.textBetween(0, doc.content.size, '\n', () => '')

/** 没有任何字符、附件或使用方节点。 */
export const isComposerEmpty = (doc: PMNode): boolean => {
  let empty = true
  doc.descendants((node) => {
    if (node.isText || (node.isInline && node.isAtom)) empty = false
    return empty
  })
  return empty
}
