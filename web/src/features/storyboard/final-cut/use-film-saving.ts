import { use, useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { BEATS_DIR } from './beat-file'
import { PROJECT_MAIN } from './composition/film'
import { storedFilesOf, unsaved } from './film-files'
import {
  holdProjectReads,
  PROJECT_DIR,
  PROJECT_MAIN_PATH,
  projectLocaleOf,
  readProject,
  writeProjectFile,
} from './final-cut.api'
import { localeOfPath } from './locales'
import type { ProjectSession } from './use-film-project'
import type { SaveState } from './use-film-session'

/**
 * 会话的保存和别处改动的检查（见 `useFilmSession`）：编辑停手 `debounceMs` 毫秒后存、卸载时补存（`saveNow`），
 * 工作区里打开着的文件或语言值表变了时检查是不是别处改的、是就换成那一份（`adoptStored`），预览要读的别的文件变了时
 * `filesRevision` 加 1。
 */
export function useFilmSaving(
  conversationId: string,
  debounceMs: number,
  { film, projectRef, presentRef, addingLocaleRef, adoptStored }: ProjectSession,
) {
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [filesRevision, setFilesRevision] = useState(0)
  const inFlightRef = useRef<Promise<void> | null>(null)

  /** 在途的保存和正在加的语言都结束。 */
  const settled = useCallback(async () => {
    while (inFlightRef.current !== null || addingLocaleRef.current !== null)
      await (inFlightRef.current ?? addingLocaleRef.current)
  }, [addingLocaleRef])

  const saveNow = useCallback(async (): Promise<'saved' | 'clean' | 'reloaded' | 'failed'> => {
    // 多处同时等待同一次在途保存时，唤醒后需循环确认无其他调用方抢先发起新保存；
    // 退出循环至下方写入 `inFlightRef` 之间无 `await`，保证同一时刻只有一次保存在写。
    do await settled()
    while (inFlightRef.current !== null || addingLocaleRef.current !== null)
    const present = presentRef.current
    // 字幕场景先存、主文件后存：主文件挂载着场景，先存主文件的话导出可能取到还没存的场景
    const writes = [...(projectRef.current?.files ?? [])]
      .flatMap(([path, file]) => {
        const content = present.get(path)
        return content === undefined || content === file.saved ? [] : [{ path, file, content }]
      })
      .toSorted(
        (left, right) => Number(left.path === PROJECT_MAIN) - Number(right.path === PROJECT_MAIN),
      )
    if (writes.length === 0) return 'clean'
    const run = (async () => {
      setSave({ kind: 'saving' })
      try {
        for (const { path, file, content } of writes) {
          file.version = await writeProjectFile(conversationId, path, content, file.version)
          file.saved = content
        }
        setSave({ kind: 'idle' })
        return 'saved' as const
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          try {
            await adoptStored(await readProject(conversationId))
            setSave({ kind: 'idle' })
            return 'reloaded' as const
          } catch (reloadError) {
            setSave({ kind: 'failed', message: errorMessageOf(reloadError, 'final-cut 读取失败') })
            return 'failed' as const
          }
        }
        setSave({ kind: 'failed', message: errorMessageOf(error, 'final-cut 保存失败') })
        return 'failed' as const
      }
    })()
    inFlightRef.current = run.then(() => undefined)
    try {
      return await run
    } finally {
      inFlightRef.current = null
    }
  }, [adoptStored, conversationId, settled, addingLocaleRef, presentRef, projectRef])

  /**
   * 响应工作区已打开文件（初始化前视作主文件）或语言值表变更通知：通知不含版本号且自身保存也会触发。
   * 先等待在途保存结束再读取远端快照，读取完成后再次确认无并发保存落盘；
   * 仅当某文件远端版本号新于本地已知版本（或文件新增/删除，含外部新增语言值表）时认定为外部修改。
   */
  const checkStored = useCallback(async () => {
    try {
      await settled()
      const stored = await readProject(conversationId)
      await settled()
      const storedFiles = storedFilesOf(stored)
      const files = projectRef.current?.files
      const paths = new Set([
        ...(files?.keys() ?? [PROJECT_MAIN]),
        ...[...storedFiles.keys()].filter((path) => localeOfPath(path) !== undefined),
      ])
      const external = [...paths].some((path) => {
        const found = storedFiles.get(path) ?? null
        const known = files?.get(path)?.version ?? null
        return found === null ? known !== null : known === null || found.version > known
      })
      if (external) await adoptStored(stored)
    } catch (error) {
      setSave({ kind: 'failed', message: errorMessageOf(error, 'final-cut 读取失败') })
    }
  }, [adoptStored, conversationId, settled, projectRef])

  const connection = use(TranscriptConnectionContext)
  useEffect(() => {
    if (connection === null) return undefined
    const unwatchFiles = connection.watchFs(
      conversationId,
      [PROJECT_DIR],
      (changes) => {
        const opened = [...(projectRef.current?.files.keys() ?? [PROJECT_MAIN])]
        const watched = new Set(opened.map((path) => `${PROJECT_DIR}/${path}`))
        if (
          changes.some(
            (change) => watched.has(change.path) || projectLocaleOf(change.path) !== undefined,
          )
        )
          void checkStored()
        // 预览从工作区取的文件变了要重新加载；打开着的字幕场景和语言的值随主文件一起发给预览，不用；
        // 节拍文件预览不读，也不用
        const project = projectRef.current
        const sent =
          project !== null && project.files.has(project.captionsPath)
            ? `${PROJECT_DIR}/${project.captionsPath}`
            : undefined
        if (
          changes.some(
            (change) =>
              change.path !== PROJECT_MAIN_PATH &&
              change.path !== sent &&
              projectLocaleOf(change.path) === undefined &&
              !change.path.startsWith(`${PROJECT_DIR}/${BEATS_DIR}/`),
          )
        )
          setFilesRevision((revision) => revision + 1)
      },
      { recursive: true },
    )
    // 断线期间的通知收不到：重连后按打开着的文件变了、别的文件也变了处理
    const unwatchSessions = connection.watchSessions((update) => {
      if (update.kind !== 'reconnected') return
      void checkStored()
      setFilesRevision((revision) => revision + 1)
    })
    return () => {
      unwatchFiles()
      unwatchSessions()
    }
  }, [checkStored, connection, conversationId, projectRef])

  useEffect(() => {
    if (film === null || !unsaved(projectRef.current, presentRef.current)) return
    const timer = setTimeout(() => void saveNow(), debounceMs)
    return () => clearTimeout(timer)
  }, [film, debounceMs, saveNow, presentRef, projectRef])

  // 卸载时把没存的存掉；连同还在途的那次一起交给主文件的读取，再打开时等它们存完再读
  useEffect(
    () => () => {
      if (unsaved(projectRef.current, presentRef.current) || inFlightRef.current !== null)
        holdProjectReads(conversationId, saveNow())
    },
    [conversationId, saveNow, presentRef, projectRef],
  )

  return { save, filesRevision, saveNow }
}
