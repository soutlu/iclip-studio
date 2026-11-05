import { useState } from 'react'
import type { ComposerNode } from './composer-node'
import { acceptsKind, type ComposerAccept, type ComposerPart } from './use-composer-attachments'

export type ComposerAttachmentLimit = {
  readonly remaining: () => number
  readonly notice: (dropped: number) => string
}

type AnyPart = ComposerPart<ComposerNode>

export const DIRECTORY_NOTICE = '无法添加文件夹'

export const useAttachmentAdmission = (
  accept: ComposerAccept,
  limit: ComposerAttachmentLimit | undefined,
) => {
  const [notice, setNotice] = useState<string | null>(null)

  const admitFiles = (files: readonly File[]): File[] => {
    if (limit === undefined) return [...files]
    const room = Math.max(0, limit.remaining())
    const dropped = Math.max(0, files.length - room)
    setNotice(dropped > 0 ? limit.notice(dropped) : null)
    return files.slice(0, room)
  }

  const admitPasted = (parts: readonly AnyPart[]): AnyPart[] => {
    const accepted = parts.filter(
      (part) => part.kind !== 'media' || acceptsKind(accept, part.media.kind),
    )
    if (limit === undefined) return accepted
    let room = Math.max(0, limit.remaining())
    let dropped = 0
    const admitted = accepted.filter((part) => {
      if (part.kind !== 'media') return true
      if (room > 0) {
        room -= 1
        return true
      }
      dropped += 1
      return false
    })
    setNotice(dropped > 0 ? limit.notice(dropped) : null)
    return admitted
  }

  return { admitFiles, admitPasted, notice, setNotice }
}
