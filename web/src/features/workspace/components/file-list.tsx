/** 按目录分组的文件列表：类型图标、文件名，大小与时间各占一列右对齐。点一行进阅读。 */

import { useCallback } from 'react'
import { Icon } from '@/shared/icons'
import type { ConversationFileOut } from '@/shared/api/generated'
import { baseName } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { fileIconOf, formatBytes, formatWhen, groupByDirectory } from '../file-kind'
import { PanelNotice } from './panel-notice'

type FileListProps = {
  files: readonly ConversationFileOut[] | undefined
  pending: boolean
  error: string | undefined
  /** 刚从阅读页返回时，上次打开的那一份：留一层灰并接回焦点，回来就知道停在哪。 */
  lastOpened: string | undefined
  onOpen: (path: string) => void
}

export function FileList({ error, files, lastOpened, onOpen, pending }: FileListProps) {
  // 只在这一行挂上时聚焦一次；滚动跟着焦点把它带进视野。
  const focusOnMount = useCallback((node: HTMLButtonElement | null) => node?.focus(), [])

  if (pending) return <PanelNotice text="正在读取文件…" />
  if (error !== undefined) return <PanelNotice text={error} />
  if (files === undefined || files.length === 0) {
    return <PanelNotice hint="agent 写入的所有文件都将显示在这里" text="暂无文件" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
      {groupByDirectory(files).map((group) => (
        <section aria-label={group.dir === '' ? '根目录' : group.dir} key={group.dir}>
          {group.dir === '' ? null : (
            <h3 className="flex items-center gap-1.5 px-2 pt-3 pb-0.5 text-label text-on-surface-faint">
              <Icon className="shrink-0" decorative name="folder" size="xs" />
              <span className="min-w-0 truncate">{group.dir}</span>
            </h3>
          )}
          <ul className="flex flex-col">
            {group.files.map((file) => {
              const last = file.path === lastOpened
              return (
                <li key={file.path}>
                  <button
                    aria-current={last ? 'true' : undefined}
                    className={cn(
                      'grid w-full ui-state cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-sm px-2 py-2 text-left ui-focus',
                      last && 'bg-state-active',
                    )}
                    onClick={() => onOpen(file.path)}
                    ref={last ? focusOnMount : undefined}
                    type="button"
                  >
                    <Icon
                      className="text-on-surface-variant"
                      decorative
                      name={fileIconOf(file.path)}
                      size="md"
                    />
                    <span className="truncate text-body text-on-surface">
                      {baseName(file.path)}
                    </span>
                    <span className="w-16 text-right text-label text-on-surface-faint tabular-nums">
                      {formatBytes(file.sizeBytes)}
                    </span>
                    <span className="w-24 text-right text-label text-on-surface-faint tabular-nums">
                      {formatWhen(file.updatedAt)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
