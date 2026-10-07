import type { IconName } from '@/shared/icons'
import { extensionOf } from '@/shared/lib/file-kind'

const FILE_ICONS: Partial<Record<string, IconName>> = {
  md: 'file',
  markdown: 'file',
  mdx: 'file',
  json: 'file-json',
  jsonc: 'file-json',
  json5: 'file-json',
  txt: 'file-plain',
  avif: 'file-image',
  gif: 'file-image',
  jpeg: 'file-image',
  jpg: 'file-image',
  png: 'file-image',
  svg: 'file-image',
  webp: 'file-image',
  m4v: 'file-video',
  mov: 'file-video',
  mp4: 'file-video',
  webm: 'file-video',
}

/** 列表与阅读页头的类型图标只看后缀：同一套线性图形靠形状区分，认不出的后缀给空白文件。 */
export const fileIconOf = (path: string): IconName => FILE_ICONS[extensionOf(path)] ?? 'file-other'

/** 根目录文件的目录是空串。 */
export const dirName = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** 截中间时固定显示的主名末尾字数（扩展名另算）。 */
const KEPT_STEM_TAIL = 4

/**
 * 把文件名拆成「可截的开头」与「固定的结尾」，供页头纯 CSS 截中间：窄宽时开头出省略号，
 * 结尾（主名末 4 字 + 扩展名）始终可见，如 `vid…shot.json`。
 * 没有扩展名（含 `.gitignore` 这类点开头的名字）或主名不超过 4 字时不拆，`tail` 为空串，整名按末尾截断。
 */
export const splitFileName = (name: string): { head: string; tail: string } => {
  const cut = name.lastIndexOf('.') - KEPT_STEM_TAIL
  if (cut <= 0) return { head: name, tail: '' }
  return { head: name.slice(0, cut), tail: name.slice(cut) }
}

export type FileGroup<T extends { path: string }> = {
  dir: string
  files: T[]
}

/** 根目录在前，其余目录按路径排序；同目录内按文件名排序。 */
export const groupByDirectory = <T extends { path: string }>(
  files: readonly T[],
): FileGroup<T>[] => {
  const groups = new Map<string, T[]>()
  for (const file of files) {
    const dir = dirName(file.path)
    groups.set(dir, [...(groups.get(dir) ?? []), file])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left === '' ? -1 : right === '' ? 1 : left.localeCompare(right)))
    .map(([dir, members]) => ({
      dir,
      files: [...members].sort((left, right) => left.path.localeCompare(right.path)),
    }))
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 当天只给时分，往前的日子带上月日；无效时间给空串。 */
export const formatWhen = (iso: string, now = new Date()): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  return sameDay ? time : `${at.getMonth() + 1}月${at.getDate()}日 ${time}`
}
