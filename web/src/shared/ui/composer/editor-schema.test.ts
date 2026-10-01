import { describe, expect, it } from 'vitest'
import type { ComposerNodeSpec } from './composer-node'
import {
  createComposerSchema,
  isComposerEmpty,
  readComposerSegments,
  readComposerText,
} from './editor-schema'

type MarkNode = { name: 'mark'; attrs: { id: string } }
const markSpec: ComposerNodeSpec<MarkNode> = {
  attrNames: ['id'],
  leafText: (node) => `【${node.attrs.id}】`,
  name: 'mark',
  render: () => null,
}
const composerSchema = createComposerSchema([markSpec])

const nodeType = (name: 'attachment' | 'doc' | 'mark' | 'paragraph') => {
  const type = composerSchema.nodes[name]
  if (type === undefined) throw new Error(`schema 里没有 ${name}`)
  return type
}
const pill = (attId: string) =>
  nodeType('attachment').create({ attId, kind: 'image', name: `${attId}.jpg` })
const mark = (id: string) => nodeType('mark').create({ id })
const paragraph = (...content: ReturnType<typeof composerSchema.text>[]) =>
  nodeType('paragraph').create(null, content)
const doc = (...paragraphs: ReturnType<typeof paragraph>[]) =>
  nodeType('doc').create(null, paragraphs)

describe('readComposerSegments', () => {
  it('文字与 pill 按出现顺序交替，图落在它被提到的那句话旁边', () => {
    const document = doc(
      paragraph(
        composerSchema.text('这一帧换成这张图的角度 '),
        pill('a'),
        composerSchema.text('，鞋侧面要露出透气孔 '),
        pill('b'),
      ),
    )

    expect(readComposerSegments(document)).toEqual([
      { kind: 'text', text: '这一帧换成这张图的角度 ' },
      { attId: 'a', kind: 'attachment' },
      { kind: 'text', text: '，鞋侧面要露出透气孔 ' },
      { attId: 'b', kind: 'attachment' },
    ])
  })

  it('段落之间用换行连，首尾空白去掉，空段不留', () => {
    const document = doc(
      paragraph(composerSchema.text('  第一行')),
      paragraph(),
      paragraph(composerSchema.text('第三行  ')),
    )

    expect(readComposerSegments(document)).toEqual([{ kind: 'text', text: '第一行\n\n第三行' }])
  })

  it('只有 pill 没有字：没有文字段', () => {
    expect(readComposerSegments(doc(paragraph(pill('a'))))).toEqual([
      { attId: 'a', kind: 'attachment' },
    ])
  })

  it('压平的文字与切段拼回去一致', () => {
    const document = doc(
      paragraph(composerSchema.text('看这张 '), pill('a'), composerSchema.text(' 再改')),
    )
    const flat = readComposerSegments(document)
      .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
      .join('')
    expect(flat).toBe(readComposerText(document))
  })

  it('使用方节点单独成段，带上节点名与 attrs；纯文字里没有它', () => {
    const document = doc(
      paragraph(composerSchema.text('把 '), mark('m1'), composerSchema.text(' 去掉')),
    )

    expect(readComposerSegments(document)).toEqual([
      { kind: 'text', text: '把 ' },
      { kind: 'node', node: { attrs: { id: 'm1' }, name: 'mark' } },
      { kind: 'text', text: ' 去掉' },
    ])
    expect(readComposerText(document)).toBe('把  去掉')
    expect(
      document.textBetween(
        0,
        document.content.size,
        '',
        (leaf) => leaf.type.spec.leafText?.(leaf) ?? '',
      ),
    ).toBe('把 【m1】 去掉')
  })
})

describe('isComposerEmpty', () => {
  it.each([
    ['空段落', () => doc(paragraph()), true],
    ['只有空格', () => doc(paragraph(composerSchema.text(' '))), false],
    ['只有附件', () => doc(paragraph(pill('a'))), false],
    ['只有使用方节点', () => doc(paragraph(mark('m1'))), false],
  ])('%s', (_, build, empty) => {
    expect(isComposerEmpty(build())).toBe(empty)
  })
})

describe('createComposerSchema', () => {
  it('同一组 spec 只建一次 schema', () => {
    const specs = [markSpec]
    expect(createComposerSchema(specs)).toBe(createComposerSchema(specs))
    expect(createComposerSchema()).toBe(createComposerSchema())
  })
})
