import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import type { ComposerNode } from './composer-node'

export type ComposerAttachmentKind = 'file' | 'image' | 'video'

export type ComposerAccept = 'image' | 'media'

export type ComposerAttachment = {
  readonly attId: string
  readonly kind: ComposerAttachmentKind
  readonly name: string
  readonly size: number | undefined
  readonly mediaType: string
  readonly status: 'error' | 'ready' | 'uploading'
  readonly progress: number | undefined
  readonly previewUrl: string | undefined
  readonly url: string | undefined
  readonly error: string | undefined
  readonly file: File | undefined
}

const PROGRESS_WRITE_MS = 120

const UNSUPPORTED: Record<ComposerAccept, string> = {
  image: '该文件不是图片，无法添加；请选择图片',
  media: '该文件不是图片或视频，无法添加；请选择图片或视频',
}

export const acceptsKind = (accept: ComposerAccept, kind: ComposerAttachmentKind): boolean =>
  kind === 'image' || (accept === 'media' && kind === 'video')

const mintAttachmentId = (): string => Math.random().toString(36).slice(2, 10)

export const readyAttachment = ({
  kind,
  name,
  url,
}: {
  kind: ComposerAttachmentKind
  name: string
  url: string
}): ComposerAttachment => ({
  attId: mintAttachmentId(),
  error: undefined,
  file: undefined,
  kind,
  mediaType: `${kind}/*`,
  name,
  previewUrl: url,
  progress: undefined,
  size: undefined,
  status: 'ready',
  url,
})

const kindOf = (mediaType: string): ComposerAttachmentKind =>
  mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('video/') ? 'video' : 'file'

const previewUrlOf = (kind: ComposerAttachmentKind, file: File): string | undefined => {
  if (kind === 'file' || typeof URL.createObjectURL !== 'function') return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

const revokePreview = (entry: ComposerAttachment) => {
  if (entry.previewUrl?.startsWith('blob:') === true) URL.revokeObjectURL(entry.previewUrl)
}

export const useComposerAttachments = (accept: ComposerAccept = 'media') => {
  const [entries, setEntries] = useState<ReadonlyMap<string, ComposerAttachment>>(() => new Map())
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  useEffect(
    () => () => {
      for (const entry of entriesRef.current.values()) revokePreview(entry)
    },
    [],
  )

  const patch = (attId: string, partial: Partial<ComposerAttachment>) => {
    setEntries((prev) => {
      const current = prev.get(attId)
      if (current === undefined) return prev
      const next = new Map(prev)
      next.set(attId, { ...current, ...partial })
      return next
    })
  }

  const upload = async (entry: ComposerAttachment, file: File) => {
    const { kind } = entry
    if (kind === 'file' || !acceptsKind(accept, kind)) {
      patch(entry.attId, { error: UNSUPPORTED[accept], status: 'error' })
      return
    }
    let lastPercent = -1
    let lastWrittenAt = 0
    const onProgress = (ratio: number) => {
      const percent = Math.floor(ratio * 100)
      const now = Date.now()
      if (percent === lastPercent) return
      if (percent < 100 && now - lastWrittenAt < PROGRESS_WRITE_MS) return
      lastPercent = percent
      lastWrittenAt = now
      patch(entry.attId, { progress: ratio })
    }
    try {
      const { url } = await uploadMediaFile(file, kind, { onProgress })
      setEntries((prev) => {
        const current = prev.get(entry.attId)
        if (current === undefined) return prev
        revokePreview(current)
        const next = new Map(prev)
        next.set(entry.attId, {
          ...current,
          file: undefined,
          previewUrl: url,
          progress: undefined,
          status: 'ready',
          url,
        })
        return next
      })
    } catch (error) {
      patch(entry.attId, {
        error: errorMessageOf(error, '上传失败'),
        progress: undefined,
        status: 'error',
      })
    }
  }

  const mintEntry = (file: File): ComposerAttachment => {
    const kind = kindOf(file.type)
    const entry: ComposerAttachment = {
      attId: mintAttachmentId(),
      error: undefined,
      file,
      kind,
      mediaType: file.type === '' ? `${kind}/*` : file.type,
      name: file.name,
      previewUrl: previewUrlOf(kind, file),
      progress: undefined,
      size: file.size,
      status: 'uploading',
      url: undefined,
    }
    setEntries((prev) => new Map(prev).set(entry.attId, entry))
    void upload(entry, file)
    return entry
  }

  const retry = (attId: string) => {
    const entry = entries.get(attId)
    if (entry?.status !== 'error' || entry.file === undefined) return
    patch(attId, { error: undefined, progress: undefined, status: 'uploading' })
    void upload(entry, entry.file)
  }

  const purgeExcept = useCallback((attIdsInDoc: readonly string[]) => {
    setEntries((prev) => {
      const live = new Set(attIdsInDoc)
      let changed = false
      const next = new Map(prev)
      for (const [attId, entry] of prev) {
        if (live.has(attId)) continue
        changed = true
        next.delete(attId)
        revokePreview(entry)
      }
      return changed ? next : prev
    })
  }, [])

  const takeReady = (attIdsInDoc: readonly string[]): ComposerAttachment[] =>
    attIdsInDoc.flatMap((attId) => {
      const entry = entries.get(attId)
      return entry !== undefined && entry.status === 'ready' && entry.url !== undefined
        ? [entry]
        : []
    })

  const restoreEntries = useCallback((list: readonly ComposerAttachment[]) => {
    setEntries((prev) => {
      const next = new Map(prev)
      for (const entry of list) next.set(entry.attId, entry)
      return next
    })
  }, [])

  return { entries, mintEntry, purgeExcept, restoreEntries, retry, takeReady }
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>

type NodePart<N extends ComposerNode> = [N] extends [never]
  ? never
  : { readonly kind: 'node'; readonly node: N }

export type ComposerPart<N extends ComposerNode = never> =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'media'; readonly media: ComposerAttachment }
  | NodePart<N>

export type ComposerSubmission<N extends ComposerNode = never> = {
  readonly text: string
  readonly media: readonly ComposerAttachment[]
  readonly parts: readonly ComposerPart<N>[]
}
