import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, errorMessageOf, UserFacingError } from '@/shared/api/client'
import { readWorkspaceFile, workspaceQueryKeys, writeWorkspaceFile } from '@/shared/workbench'
import {
  parseShotsDocument,
  validateShotsDocument,
  type Shot,
  type ShotsDocument,
} from './shot-document'

const SAVE_DELAY_MS = 800

export type ShotConflict = { index: number; mine: Shot | undefined; theirs: Shot | undefined }
export type AspectConflict = { mine: string; theirs: string }
export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; shots: ShotConflict[]; aspect?: AspectConflict }

const ASPECT_KEY = 'aspect_ratio'
type DirtyKey = number | typeof ASPECT_KEY

const shotKeys = (keys: ReadonlySet<DirtyKey>): number[] =>
  [...keys].filter((key): key is number => key !== ASPECT_KEY)

type Base = { version: number; document: ShotsDocument }
type UploadedFrame = { index: number; frame: number; url: string }
type UseShotsDraftOptions = {
  conversationId: string
  path: string
  file: { content: string; version: number } | undefined
}

const shotOf = (document: ShotsDocument, index: number) =>
  document.shots.find((shot) => shot.index === index)

const sameShot = (left: Shot | undefined, right: Shot | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const changedKeys = (base: ShotsDocument, document: ShotsDocument) => {
  const keys = new Set<DirtyKey>(
    document.shots.flatMap((shot) =>
      sameShot(shot, shotOf(base, shot.index)) ? [] : [shot.index],
    ),
  )
  if (base.aspect_ratio !== document.aspect_ratio) keys.add(ASPECT_KEY)
  return keys
}

const replay = (latest: ShotsDocument, mine: ShotsDocument, dirty: ReadonlySet<DirtyKey>) => ({
  ...latest,
  aspect_ratio: dirty.has(ASPECT_KEY) ? mine.aspect_ratio : latest.aspect_ratio,
  shots: latest.shots.map((shot) =>
    dirty.has(shot.index) ? (shotOf(mine, shot.index) ?? shot) : shot,
  ),
})

const conflictingKeys = (
  base: ShotsDocument,
  latest: ShotsDocument,
  mine: ShotsDocument,
  dirty: ReadonlySet<DirtyKey>,
) => {
  const keys = new Set<DirtyKey>(
    shotKeys(dirty).filter(
      (index) =>
        !sameShot(shotOf(latest, index), shotOf(base, index)) &&
        !sameShot(shotOf(latest, index), shotOf(mine, index)),
    ),
  )
  if (
    dirty.has(ASPECT_KEY) &&
    latest.aspect_ratio !== base.aspect_ratio &&
    latest.aspect_ratio !== mine.aspect_ratio
  )
    keys.add(ASPECT_KEY)
  return keys
}

export const useShotsDraft = ({ conversationId, file, path }: UseShotsDraftOptions) => {
  const queryClient = useQueryClient()
  const content = file?.content
  const parsed = useMemo(
    () => (content === undefined ? null : parseShotsDocument(content)),
    [content],
  )
  const [edited, setEdited] = useState<ShotsDocument | null>(null)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const [uploads, setUploads] = useState<readonly UploadedFrame[]>([])
  const [lastSaved, setLastSaved] = useState<Base | null>(null)
  const ledgerRef = useRef({
    base: null as Base | null,
    edited: null as ShotsDocument | null,
    dirty: new Set<DirtyKey>(),
    latest: null as Base | null,
    conflicts: new Set<DirtyKey>(),
    inFlight: null as Promise<ShotsDocument | null> | null,
    timer: null as ReturnType<typeof setTimeout> | null,
  })

  useEffect(() => {
    const book = ledgerRef.current
    if (file === undefined || parsed === null || book.dirty.size > 0 || book.inFlight !== null)
      return
    if (book.base === null || file.version >= book.base.version) {
      book.base = { document: parsed, version: file.version }
    }
  }, [file, parsed])

  const clearTimer = useCallback(() => {
    const book = ledgerRef.current
    if (book.timer !== null) clearTimeout(book.timer)
    book.timer = null
  }, [])

  const showConflict = useCallback(() => {
    const book = ledgerRef.current
    if (book.latest === null || book.edited === null) return
    const latest = book.latest.document
    const mine = book.edited
    setState({
      kind: 'conflict',
      shots: shotKeys(book.conflicts).map((index) => ({
        index,
        mine: shotOf(mine, index),
        theirs: shotOf(latest, index),
      })),
      ...(book.conflicts.has(ASPECT_KEY)
        ? { aspect: { mine: mine.aspect_ratio, theirs: latest.aspect_ratio } }
        : {}),
    })
  }, [])

  const saveNow = useCallback((): Promise<ShotsDocument | null> => {
    const book = ledgerRef.current
    clearTimer()
    if (book.inFlight !== null) return book.inFlight
    if (book.latest !== null) {
      showConflict()
      return Promise.resolve(null)
    }
    if (book.base === null) return Promise.resolve(null)
    if (book.edited === null || book.dirty.size === 0) return Promise.resolve(book.base.document)

    const run = async (): Promise<ShotsDocument | null> => {
      let rebased = false
      let landed: ShotsDocument | null = null
      while (book.edited !== null && book.dirty.size > 0 && book.base !== null) {
        const mine = book.edited
        const base = book.base
        const problem = validateShotsDocument(mine)
        if (problem !== undefined) {
          clearTimer()
          setState({ kind: 'error', message: `分镜未保存，${problem}` })
          return null
        }
        setState({ kind: 'saving' })
        try {
          const saved = await writeWorkspaceFile(
            conversationId,
            { content: JSON.stringify(mine, null, 2), expectedVersion: base.version, path },
            '分镜保存失败',
          )
          book.base = { document: mine, version: saved.file.version }
          setLastSaved(book.base)
          landed = mine
          const current = book.edited ?? mine
          book.dirty = changedKeys(mine, current)
          book.edited = book.dirty.size === 0 ? null : current
          setEdited(book.edited)
          queryClient.setQueryData(workspaceQueryKeys.file(conversationId, path), saved)
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409 || rebased) {
            clearTimer()
            setState({ kind: 'error', message: errorMessageOf(error, '分镜保存失败') })
            return null
          }
          const latestFile = await queryClient.fetchQuery({
            queryFn: ({ signal }) => readWorkspaceFile(conversationId, path, signal),
            queryKey: workspaceQueryKeys.file(conversationId, path),
            staleTime: 0,
          })
          const latestDocument = parseShotsDocument(latestFile.file.content)
          if (latestDocument === null) {
            clearTimer()
            setState({ kind: 'error', message: '最新文件格式不正确，草稿已保留' })
            return null
          }
          const latest: Base = { document: latestDocument, version: latestFile.file.version }
          const current = book.edited ?? mine
          const conflicts = conflictingKeys(base.document, latest.document, current, book.dirty)
          if (conflicts.size > 0) {
            book.latest = latest
            book.conflicts = conflicts
            clearTimer()
            showConflict()
            return null
          }
          const merged = replay(latest.document, current, book.dirty)
          book.base = latest
          book.dirty = changedKeys(latest.document, merged)
          book.edited = book.dirty.size === 0 ? null : merged
          setEdited(book.edited)
          rebased = true
        }
      }
      clearTimer()
      setState({ kind: 'saved' })
      return landed
    }

    book.inFlight = run()
      .catch((error: unknown) => {
        clearTimer()
        setState({ kind: 'error', message: errorMessageOf(error, '分镜保存失败') })
        return null
      })
      .finally(() => {
        book.inFlight = null
      })
      .then((landed) => (landed !== null && book.dirty.size === 0 ? landed : null))
    return book.inFlight
  }, [clearTimer, conversationId, path, queryClient, showConflict])

  const commit = useCallback(
    (document: ShotsDocument, key: DirtyKey) => {
      const book = ledgerRef.current
      book.edited = document
      book.dirty.add(key)
      setEdited(document)
      clearTimer()
      if (book.latest !== null && book.base !== null) {
        const latest = book.latest
        book.conflicts = conflictingKeys(book.base.document, latest.document, document, book.dirty)
        if (book.conflicts.size > 0) {
          showConflict()
          return
        }
        const merged = replay(latest.document, document, book.dirty)
        book.base = latest
        book.latest = null
        book.dirty = changedKeys(latest.document, merged)
        book.edited = book.dirty.size === 0 ? null : merged
        setEdited(book.edited)
      }
      setState(book.inFlight === null ? { kind: 'idle' } : { kind: 'saving' })
      book.timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS)
    },
    [clearTimer, saveNow, showConflict],
  )

  const updateShot = useCallback(
    (index: number, update: (current: Shot) => Shot): Shot | undefined => {
      const book = ledgerRef.current
      const current = book.edited ?? book.base?.document
      const shot = current === undefined ? undefined : shotOf(current, index)
      if (current === undefined || shot === undefined) {
        setState({ kind: 'error', message: '该镜头组已不存在，请重新读取分镜' })
        return undefined
      }
      const next = update(shot)
      if (sameShot(shot, next)) return next
      if (next.index !== index) throw new Error('编辑不能更改镜头组编号')
      commit(
        { ...current, shots: current.shots.map((item) => (item.index === index ? next : item)) },
        index,
      )
      return next
    },
    [commit],
  )

  const updateAspectRatio = useCallback(
    (aspectRatio: string) => {
      const book = ledgerRef.current
      const current = book.edited ?? book.base?.document
      if (current === undefined || current.aspect_ratio === aspectRatio) return
      commit({ ...current, aspect_ratio: aspectRatio }, ASPECT_KEY)
    },
    [commit],
  )

  const replaceFrame = useCallback(
    (index: number, frame: number, previousUrl: string, url: string) => {
      const result = updateShot(index, (shot) => {
        if (!Number.isInteger(frame) || frame < 1 || shot.image_urls[frame - 1] !== previousUrl) {
          throw new UserFacingError('该图片已发生变化，请重新选择要替换的图片')
        }
        return {
          ...shot,
          image_urls: shot.image_urls.map((image, position) =>
            position === frame - 1 ? url : image,
          ),
        }
      })
      if (result === undefined) throw new UserFacingError('目标镜头组已不存在，上传结果未写入分镜')
    },
    [updateShot],
  )

  const applyFrame = useCallback(
    async (index: number, frame: number, previousUrl: string, url: string) => {
      const book = ledgerRef.current
      if (book.inFlight !== null) throw new UserFacingError('当前修改正在保存，请稍后重试')
      if (book.latest !== null)
        throw new UserFacingError('分镜存在版本冲突，无法替换图片；请处理冲突')
      const current = book.edited ?? book.base?.document
      const target = current === undefined ? undefined : shotOf(current, index)
      const replaced = target?.image_urls[frame - 1] !== url
      if (replaced) replaceFrame(index, frame, previousUrl, url)
      if ((await saveNow()) === null) {
        const currentDraft = book.edited
        const currentShot = currentDraft === null ? undefined : shotOf(currentDraft, index)
        if (replaced && currentDraft !== null && currentShot?.image_urls[frame - 1] === url) {
          const restored = {
            ...currentShot,
            image_urls: currentShot.image_urls.map((image, position) =>
              position === frame - 1 ? previousUrl : image,
            ),
          }
          const restoredDocument = {
            ...currentDraft,
            shots: currentDraft.shots.map((shot) => (shot.index === index ? restored : shot)),
          }
          if (
            book.latest === null &&
            book.base !== null &&
            sameShot(restored, shotOf(book.base.document, index))
          )
            book.dirty.delete(index)
          book.edited = book.dirty.size === 0 ? null : restoredDocument
          setEdited(book.edited)
          setState((previous) =>
            previous.kind === 'conflict'
              ? {
                  ...previous,
                  shots: previous.shots.map((conflict) =>
                    conflict.index === index ? { ...conflict, mine: restored } : conflict,
                  ),
                }
              : previous,
          )
        }
        throw new UserFacingError('图片尚未保存，请处理保存错误或冲突后重试')
      }
    },
    [replaceFrame, saveNow],
  )

  const recordUpload = useCallback((index: number, frame: number, url: string) => {
    setUploads((current) => [
      ...current.filter((upload) => upload.index !== index || upload.frame !== frame),
      { index, frame, url },
    ])
  }, [])

  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => {
      const book = ledgerRef.current
      if (choice === 'theirs') setUploads([])
      const latest = book.latest
      const mine = book.edited
      if (latest === null || mine === null) return
      if (choice === 'theirs') {
        for (const key of book.conflicts) book.dirty.delete(key)
      } else if (
        shotKeys(book.dirty).some((index) => shotOf(latest.document, index) === undefined)
      ) {
        setState({
          kind: 'error',
          message: '原镜头组已从最新文件移除，无法按原编号覆盖；草稿已保留',
        })
        return
      }
      const merged = replay(latest.document, mine, book.dirty)
      book.latest = null
      book.conflicts.clear()
      book.base = latest
      book.dirty = changedKeys(latest.document, merged)
      book.edited = book.dirty.size === 0 ? null : merged
      setEdited(book.edited)
      setState({ kind: 'idle' })
      if (book.edited !== null) void saveNow()
    },
    [saveNow],
  )

  useEffect(
    () => () => {
      if (ledgerRef.current.timer !== null) void saveNow()
    },
    [saveNow],
  )

  const shown =
    lastSaved !== null && file !== undefined && file.version < lastSaved.version
      ? lastSaved.document
      : parsed

  const hasUnsavedUpload =
    edited !== null &&
    uploads.some(
      ({ index, frame, url }) =>
        shotOf(edited, index)?.image_urls[frame - 1] === url &&
        (shown === null ? undefined : shotOf(shown, index))?.image_urls[frame - 1] !== url,
    )

  return {
    applyFrame,
    document: edited ?? shown,
    hasUnsavedChanges: edited !== null,
    hasUnsavedUpload,
    state,
    updateAspectRatio,
    updateShot,
    recordUpload,
    replaceFrame,
    resolveConflict,
    saveNow,
  }
}
