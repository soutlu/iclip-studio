/** 根目录文件的目录是空串。 */
export const dirName = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
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
