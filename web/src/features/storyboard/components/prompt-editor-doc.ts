import type { Node as PMNode } from 'prosemirror-model'
import { createComposerSchema, type ComposerNodeSpec } from '@/shared/ui/composer'
import { FRAME_NODES, type FrameNode } from './frame-node'

const FRAME_REF = /@Image(\d+)/g

export type PromptDoc = {
  promptToDoc: (prompt: string) => PMNode
  docToPrompt: (doc: PMNode) => string
  promptOffsetAt: (doc: PMNode, position: number) => number
}

export const createPromptDoc = (
  nodes: readonly ComposerNodeSpec<FrameNode>[],
  tokens: RegExp = FRAME_REF,
): PromptDoc => {
  const promptSchema = createComposerSchema(nodes)

  const nodeType = (name: 'doc' | 'frame' | 'paragraph') => {
    const type = promptSchema.nodes[name]
    if (type === undefined) throw new Error(`prompt schema 里没有 ${name} 节点`)
    return type
  }

  const promptToDoc = (prompt: string): PMNode =>
    nodeType('doc').create(
      null,
      prompt.split('\n').map((line) => {
        const children: PMNode[] = []
        let cursor = 0
        for (const match of line.matchAll(tokens)) {
          if (match.index > cursor)
            children.push(promptSchema.text(line.slice(cursor, match.index)))
          const n = match[1] === undefined ? 0 : Number(match[1])
          children.push(nodeType('frame').create({ n, token: match[0] }))
          cursor = match.index + match[0].length
        }
        if (cursor < line.length) children.push(promptSchema.text(line.slice(cursor)))
        return nodeType('paragraph').create(null, children)
      }),
    )

  const inlineText = (node: PMNode): string => {
    if (node.isText) return node.text ?? ''
    return node.type === nodeType('frame') ? (node.attrs['token'] as string) : ''
  }

  const docToPrompt = (doc: PMNode): string => {
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

  const promptOffsetAt = (doc: PMNode, position: number): number => {
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

  return { docToPrompt, promptOffsetAt, promptToDoc }
}

export const { docToPrompt, promptOffsetAt, promptToDoc } = createPromptDoc(FRAME_NODES)
