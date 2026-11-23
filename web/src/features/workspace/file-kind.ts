import type { IconName } from '@/shared/icons'
import { extensionOf } from '@/shared/lib/file-kind'

/** 文件页分类色调名称，对应 `--color-tone-*` token。 */
export type Tone = 'copper' | 'ochre' | 'teal' | 'umber' | 'slate'

/** 文件外观配置；`foldable` 表示原文具备语法结构，在只读查看器中支持代码折叠。 */
export type FileLook = { icon: IconName; tone: Tone; foldable: boolean }

const DOC: FileLook = { foldable: false, icon: 'file-doc', tone: 'umber' }
const MARKDOWN: FileLook = { foldable: false, icon: 'file-doc', tone: 'teal' }
const DATA: FileLook = { foldable: true, icon: 'file-data', tone: 'ochre' }
const CODE: FileLook = { foldable: true, icon: 'file-code', tone: 'copper' }

const LOOKS: Partial<Record<string, FileLook>> = {
  md: MARKDOWN,
  markdown: MARKDOWN,
  mdx: MARKDOWN,
  json: DATA,
  jsonc: DATA,
  json5: DATA,
  html: CODE,
  htm: CODE,
  css: CODE,
  js: CODE,
  mjs: CODE,
  cjs: CODE,
  ts: CODE,
  tsx: CODE,
  jsx: CODE,
  svg: CODE,
  xml: CODE,
}

/** 按文件扩展名映射图标与色调：HTML / 代码为 copper，JSON 为 ochre，Markdown 为 teal，其余按纯文本归为 umber。 */
export const fileLookOf = (path: string): FileLook => LOOKS[extensionOf(path)] ?? DOC

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
