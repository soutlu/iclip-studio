import type { ConversationFileOut } from '@/shared/api/generated'
import type { IconName } from '@/shared/icons'
import { dirName, fileLookOf, type Tone } from './file-kind'

export const ROOT_ID = ''

export type TreeNode = {
  id: string
  name: string
  icon: IconName
  tone: Tone
  /** 顶层文件里排在目录后面的第一个：前面画一条分隔线。 */
  afterDirs: boolean
} & ({ kind: 'dir'; children: string[] } | { kind: 'file'; file: ConversationFileOut })

export type FileTree = {
  nodes: ReadonlyMap<string, TreeNode>
  /** 所有目录的 id，按显示顺序。 */
  dirIds: string[]
  /** 树里的文件路径，按显示顺序。 */
  filePaths: string[]
}

type Folder = { dirs: Map<string, Folder>; files: ConversationFileOut[] }

// 目录 id 是目录路径加结尾的 /，和文件路径分开
const dirIdOf = (dir: string): string => `${dir}/`

/** 文件所在的各级目录 id，由近到远。 */
export const ancestorDirIds = (path: string): string[] => {
  const ids: string[] = []
  for (let dir = dirName(path); dir !== ''; dir = dirName(dir)) ids.push(dirIdOf(dir))
  return ids
}

const byName = (left: string, right: string) => left.localeCompare(right)

/**
 * 把工作区文件排成目录树：目录在前、文件在后，同级按名字排。
 * `query` 非空时只留路径里含它的文件（不分大小写）和它们的上级目录。
 * `toneOf` 给某份文件另定色调（例如它本身就是某个页签的文档），没有就按类型；
 * 目录的色调跟它自己的第一个文件，只有子目录时跟第一个子目录。
 */
export const buildFileTree = (
  files: readonly ConversationFileOut[],
  query: string,
  toneOf: (path: string) => Tone | undefined,
): FileTree => {
  const needle = query.trim().toLowerCase()
  const root: Folder = { dirs: new Map(), files: [] }
  for (const file of files) {
    if (needle !== '' && !file.path.toLowerCase().includes(needle)) continue
    let folder = root
    for (const segment of file.path.split('/').slice(0, -1)) {
      let next = folder.dirs.get(segment)
      if (next === undefined) {
        next = { dirs: new Map(), files: [] }
        folder.dirs.set(segment, next)
      }
      folder = next
    }
    folder.files.push(file)
  }

  const nodes = new Map<string, TreeNode>()
  const dirIds: string[] = []
  const filePaths: string[] = []

  // 按显示顺序深度优先走一遍；返回子项 id 和这个目录的色调：
  // 取它自己的第一个文件（final-cut/ 跟 index.html 走，不跟排在前面的 beats/），没有文件才取第一个子目录的
  const walk = (folder: Folder, prefix: string): { children: string[]; tone: Tone | undefined } => {
    const children: string[] = []
    let firstSubdir: Tone | undefined
    let firstFile: Tone | undefined
    const subdirs = [...folder.dirs].sort(([left], [right]) => byName(left, right))
    for (const [name, sub] of subdirs) {
      const id = dirIdOf(`${prefix}${name}`)
      dirIds.push(id)
      const inner = walk(sub, id)
      firstSubdir ??= inner.tone
      // 目录只因里面有文件才存在，inner.tone 总有值
      const tone = inner.tone ?? fileLookOf(id).tone
      nodes.set(id, {
        afterDirs: false,
        children: inner.children,
        icon: 'file-folder',
        id,
        kind: 'dir',
        name,
        tone,
      })
      children.push(id)
    }
    const sorted = [...folder.files].sort((left, right) => byName(left.path, right.path))
    sorted.forEach((file, index) => {
      const look = fileLookOf(file.path)
      const tone = toneOf(file.path) ?? look.tone
      firstFile ??= tone
      filePaths.push(file.path)
      nodes.set(file.path, {
        afterDirs: prefix === '' && index === 0 && subdirs.length > 0,
        file,
        icon: look.icon,
        id: file.path,
        kind: 'file',
        name: file.path.slice(prefix.length),
        tone,
      })
      children.push(file.path)
    })
    return { children, tone: firstFile ?? firstSubdir }
  }

  const top = walk(root, '')
  nodes.set(ROOT_ID, {
    afterDirs: false,
    children: top.children,
    icon: 'file-folder',
    id: ROOT_ID,
    kind: 'dir',
    name: '',
    tone: top.tone ?? fileLookOf(ROOT_ID).tone,
  })
  return { dirIds, filePaths, nodes }
}
