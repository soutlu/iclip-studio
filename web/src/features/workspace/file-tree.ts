import type { ConversationFileOut } from '@/shared/api/generated'
import type { IconName } from '@/shared/icons'
import { dirName, fileLookOf, type Tone } from './file-kind'

export const ROOT_ID = ''

export type TreeNode = {
  id: string
  name: string
  icon: IconName
  tone: Tone
  /** 是否为目录之后的首个顶层文件：为 `true` 时在其上方渲染分隔线。 */
  afterDirs: boolean
} & ({ kind: 'dir'; children: string[] } | { kind: 'file'; file: ConversationFileOut })

export type FileTree = {
  nodes: ReadonlyMap<string, TreeNode>
  /** 全部目录节点 ID，按展示顺序排列。 */
  dirIds: string[]
  /** 全部文件路径，按展示顺序排列。 */
  filePaths: string[]
}

type Folder = { dirs: Map<string, Folder>; files: ConversationFileOut[] }

// 目录 ID 以末尾 `/` 区分于同前缀文件路径
const dirIdOf = (dir: string): string => `${dir}/`

/** 返回文件所属的全部祖先目录 ID，按由近及远排列。 */
export const ancestorDirIds = (path: string): string[] => {
  const ids: string[] = []
  for (let dir = dirName(path); dir !== ''; dir = dirName(dir)) ids.push(dirIdOf(dir))
  return ids
}

const byName = (left: string, right: string) => left.localeCompare(right)

/**
 * 将工作区文件列表构建为目录树：同级目录在前、文件在后，分别按名称排序。
 * `query` 非空时仅保留路径匹配该关键词（不区分大小写）的文件及其祖先目录。
 * `toneOf` 可为特定文件覆写色调（如页签主文档），未指定时按文件类型取色；
 * 目录色调优先取其首个直接文件的色调，无直接文件时取首个子目录的色调。
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

  // 按展示顺序深度优先遍历，返回子节点 ID 列表与目录色调：
  // 优先采用首个直接文件的色调（使 final-cut/ 跟随 index.html，而非排在前面的 beats/），无直接文件时回退至首个子目录。
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
      // 目录仅在包含文件时才被构建，正常情况下 inner.tone 非空
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
