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

export const fileIconOf = (path: string): IconName => FILE_ICONS[extensionOf(path)] ?? 'file-other'

export const dirName = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

const KEPT_STEM_TAIL = 4

export const splitFileName = (name: string): { head: string; tail: string } => {
  const cut = name.lastIndexOf('.') - KEPT_STEM_TAIL
  if (cut <= 0) return { head: name, tail: '' }
  return { head: name.slice(0, cut), tail: name.slice(cut) }
}

export type FileGroup<T extends { path: string }> = {
  dir: string
  files: T[]
}

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
