/** 新附件进编辑器之前的准入：按附件上限截断、挡下的就地提示，粘贴来的消息里不收的媒体直接丢掉。
 * 带外壳的 Composer 与不带外壳的使用方（分镜正文）共用；提示文字由使用方渲染（见 `ComposerNotice`）。 */

import { useState } from 'react'
import type { ComposerNode } from './composer-node'
import { acceptsKind, type ComposerAccept, type ComposerPart } from './use-composer-attachments'

/** 附件上限：`remaining` 是还能再收几个，新文件超出的部分不收并就地提示 `notice(没收的个数)`。 */
export type ComposerAttachmentLimit = {
  readonly remaining: () => number
  readonly notice: (dropped: number) => string
}

type AnyPart = ComposerPart<ComposerNode>

/** 拖进来的是文件夹：整批不收时的就地提示。 */
export const DIRECTORY_NOTICE = '无法添加文件夹'

export const useAttachmentAdmission = (
  accept: ComposerAccept,
  limit: ComposerAttachmentLimit | undefined,
) => {
  // 新文件被上限或文件夹挡下时的就地提示，下一次添加时重算。
  const [notice, setNotice] = useState<string | null>(null)

  /** 新文件按上限截断，挡下的给出提示；没有上限时照单全收。 */
  const admitFiles = (files: readonly File[]): File[] => {
    if (limit === undefined) return [...files]
    const room = Math.max(0, limit.remaining())
    const dropped = Math.max(0, files.length - room)
    setNotice(dropped > 0 ? limit.notice(dropped) : null)
    return files.slice(0, room)
  }

  /** 粘贴复制来的消息：不收的媒体直接丢掉（已经是公网地址，不值得留一个失败 chip），其余按上限截断。 */
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
