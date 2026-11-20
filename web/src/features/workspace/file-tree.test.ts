import { describe, expect, it } from 'vitest'
import { buildFileTree, ROOT_ID, type FileTree } from './file-tree'

const file = (path: string) => ({
  path,
  sizeBytes: 10,
  updatedAt: '2026-09-01T09:20:00Z',
  version: 1,
})

const PROJECT = [
  'storyboard.md',
  'final-cut/index.html',
  'final-cut/beats/warm.mp3.json',
  'final-cut/locales/en.json',
  'final-cut/compositions/captions.html',
  'video_shot.json',
  'frames/extraction.json',
].map(file)

const noOwner = () => undefined

// 按显示顺序把整棵树（全部展开）排成「层级 名字」
const outline = (tree: FileTree): string[] => {
  const lines: string[] = []
  const visit = (id: string, depth: number) => {
    const node = tree.nodes.get(id)
    if (node === undefined) throw new Error(id)
    if (id !== ROOT_ID) lines.push(`${depth} ${node.name}`)
    if (node.kind === 'dir') for (const child of node.children) visit(child, depth + 1)
  }
  visit(ROOT_ID, 0)
  return lines
}

describe('buildFileTree', () => {
  it('每一层目录在前、文件在后，同级按名字排；多层目录逐层嵌套', () => {
    const tree = buildFileTree(PROJECT, '', noOwner)

    expect(outline(tree)).toEqual([
      '1 final-cut',
      '2 beats',
      '3 warm.mp3.json',
      '2 compositions',
      '3 captions.html',
      '2 locales',
      '3 en.json',
      '2 index.html',
      '1 frames',
      '2 extraction.json',
      '1 storyboard.md',
      '1 video_shot.json',
    ])
    expect(tree.filePaths).toEqual([
      'final-cut/beats/warm.mp3.json',
      'final-cut/compositions/captions.html',
      'final-cut/locales/en.json',
      'final-cut/index.html',
      'frames/extraction.json',
      'storyboard.md',
      'video_shot.json',
    ])
  })

  it('只有顶层第一个文件、且前面有目录时才画分隔线', () => {
    const tree = buildFileTree(PROJECT, '', noOwner)
    const separated = [...tree.nodes.values()].filter((node) => node.afterDirs).map((n) => n.id)
    expect(separated).toEqual(['storyboard.md'])
    expect(
      buildFileTree([file('a.md'), file('b.md')], '', noOwner).nodes.get('a.md')?.afterDirs,
    ).toBe(false)
  })

  it('色调按类型；目录跟自己的第一个文件，只有子目录时跟第一个子目录；归页签的文件用页签的色调', () => {
    const tree = buildFileTree(PROJECT, '', (path) =>
      path === 'video_shot.json' ? 'slate' : undefined,
    )
    const tone = (id: string) => tree.nodes.get(id)?.tone

    expect(tone('final-cut/index.html')).toBe('copper')
    expect(tone('final-cut/locales/en.json')).toBe('ochre')
    expect(tone('storyboard.md')).toBe('teal')
    expect(tone('video_shot.json')).toBe('slate')
    expect(tone('final-cut/')).toBe('copper')
    expect(tone('final-cut/beats/')).toBe('ochre')
    expect(tone('frames/')).toBe('ochre')
    expect(buildFileTree([file('a/b/c.md')], '', noOwner).nodes.get('a/')?.tone).toBe('teal')
  })

  it('筛选不分大小写，只留路径含筛选词的文件和它们的各级目录', () => {
    const tree = buildFileTree(PROJECT, 'EN', noOwner)

    expect(outline(tree)).toEqual(['1 final-cut', '2 locales', '3 en.json'])
    expect(tree.dirIds).toEqual(['final-cut/', 'final-cut/locales/'])
  })
})
