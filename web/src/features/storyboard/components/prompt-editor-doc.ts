/** 正文与编辑器文档的互转：每行对应一个段落，帧节点保留原始 @ImageN 字符，选区偏移以原文 UTF-16 为准。
 * 文档用编辑核心的 schema（帧节点见 `frameNodeSpec`）；上传中的附件 chip 不进正文，在正文里占 0 个字符。 */

import type { Node as PMNode } from 'prosemirror-model'
import { createComposerSchema } from '@/shared/ui/composer'
import { FRAME_NODES } from './frame-node'

// 与编辑器挂载时按同一组节点建的 schema 是同一个实例。
const promptSchema = createComposerSchema(FRAME_NODES)

const nodeType = (name: 'doc' | 'frame' | 'paragraph') => {
  const type = promptSchema.nodes[name]
  if (type === undefined) throw new Error(`prompt schema 里没有 ${name} 节点`)
  return type
}

const FRAME_REF = /@Image(\d+)/g

export const promptToDoc = (prompt: string): PMNode =>
  nodeType('doc').create(
    null,
    prompt.split('\n').map((line) => {
      const nodes: PMNode[] = []
      let cursor = 0
      for (const match of line.matchAll(FRAME_REF)) {
        if (match.index > cursor) nodes.push(promptSchema.text(line.slice(cursor, match.index)))
        nodes.push(nodeType('frame').create({ n: Number(match[1]), token: match[0] }))
        cursor = match.index + match[0].length
      }
      if (cursor < line.length) nodes.push(promptSchema.text(line.slice(cursor)))
      return nodeType('paragraph').create(null, nodes)
    }),
  )

const inlineText = (node: PMNode): string => {
  if (node.isText) return node.text ?? ''
  return node.type === nodeType('frame') ? (node.attrs['token'] as string) : ''
}

export const docToPrompt = (doc: PMNode): string => {
  const lines: string[] = []
  doc.forEach((paragraph) => {
    let line = ''
    paragraph.forEach((child) => {
      line += inlineText(child)
    })
    lines.push(line)
  })
  return lines.join('\n')
}

/** 帧节点在编辑器中占一个位置，在正文中占完整标记长度。 */
export const promptOffsetAt = (doc: PMNode, position: number): number => {
  let length = 0
  let found: number | undefined
  doc.forEach((paragraph, paragraphOffset, index) => {
    if (found !== undefined) return
    if (index > 0) length += 1
    const start = paragraphOffset + 1
    if (position <= start) {
      found = length
      return
    }
    paragraph.forEach((child, offset) => {
      if (found !== undefined) return
      const childStart = start + offset
      if (position <= childStart) {
        found = length
      } else if (position < childStart + child.nodeSize) {
        found = length + (child.isText ? position - childStart : 0)
      } else {
        length += inlineText(child).length
      }
    })
    if (found === undefined && position <= start + paragraph.content.size) found = length
  })
  return found ?? length
}
