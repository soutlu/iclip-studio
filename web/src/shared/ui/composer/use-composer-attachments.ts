/** 附件条目：新增即上传，条目活到编辑器卸载或整篇重置。撤销、重做随时可能把文档里删掉的附件节点带回来，节点回来时
 * 它的状态、地址与失败原因必须还在，所以文档里删掉附件不回收条目；只有整篇重置（撤销历史一并清空）时由 purgeExcept
 * 回收文档之外的条目与本地预览。代价是删掉或发送后清空的附件条目留到卸载；就绪后释放原文件，留下的只是元信息与公网地址。
 * 上传协议与校验在 shared/api/media-upload。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import type { ComposerNode } from './composer-node'

/** image / video 可提交给 prompt；file 不上传，直接停在 error。 */
export type ComposerAttachmentKind = 'file' | 'image' | 'video'

/** 收哪些媒体：`media` 图片与视频都收；`image` 只收图片，视频与 file 一样停在 error。 */
export type ComposerAccept = 'image' | 'media'

export type ComposerAttachment = {
  readonly attId: string
  readonly kind: ComposerAttachmentKind
  readonly name: string
  /** 字节数；从公网地址恢复的附件没有此信息。 */
  readonly size: number | undefined
  readonly mediaType: string
  readonly status: 'error' | 'ready' | 'uploading'
  /** 直传期间的进度值为 0–1，按百分比变化节流更新。 */
  readonly progress: number | undefined
  /** 上传中使用本地 blob URL，就绪后使用公网地址。 */
  readonly previewUrl: string | undefined
  readonly url: string | undefined
  readonly error: string | undefined
  /** 本地选取的原文件：上传中与失败时持有，供失败后重试；就绪后释放，从公网地址恢复的附件也没有。 */
  readonly file: File | undefined
}

/** 百分比变化且距上次至少 120ms 才更新；100% 不节流。 */
const PROGRESS_WRITE_MS = 120

const UNSUPPORTED: Record<ComposerAccept, string> = {
  image: '只能添加图片',
  media: '只能添加图片或视频附件',
}

/** 这种媒体收不收。 */
export const acceptsKind = (accept: ComposerAccept, kind: ComposerAttachmentKind): boolean =>
  kind === 'image' || (accept === 'media' && kind === 'video')

/** 参考 Kimi Pu()，使用八位 base36 随机附件 ID。 */
const mintAttachmentId = (): string => Math.random().toString(36).slice(2, 10)

/** 复用公网媒体地址创建就绪附件，无需重新上传。 */
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

/** 按 MIME 前缀区分 image、video 与 file。 */
const kindOf = (mediaType: string): ComposerAttachmentKind =>
  mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('video/') ? 'video' : 'file'

/** 环境不支持对象 URL 时不生成本地预览。 */
const previewUrlOf = (kind: ComposerAttachmentKind, file: File): string | undefined => {
  if (kind === 'file' || typeof URL.createObjectURL !== 'function') return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

/** 仅回收本地对象 URL，不撤销公网地址。 */
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

  /** 忽略已回收条目（整篇重置后）的异步回写，避免回收后重新出现。 */
  const patch = (attId: string, partial: Partial<ComposerAttachment>) => {
    setEntries((prev) => {
      const current = prev.get(attId)
      if (current === undefined) return prev
      const next = new Map(prev)
      next.set(attId, { ...current, ...partial })
      return next
    })
  }

  /** 任一步上传失败均进入 error 状态并保留可展示的错误文案。 */
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
      const url = await uploadMediaFile(file, kind, { onProgress })
      setEntries((prev) => {
        const current = prev.get(entry.attId)
        if (current === undefined) return prev
        revokePreview(current)
        const next = new Map(prev)
        // 上传后将预览替换为公网地址，保证本地 URL 回收后仍可查看；原文件只为失败重试而留，就绪即释放。
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

  /** 失败条目用原文件重新上传，本地预览沿用；非失败态或没有原文件时不执行。 */
  const retry = (attId: string) => {
    const entry = entries.get(attId)
    if (entry?.status !== 'error' || entry.file === undefined) return
    patch(attId, { error: undefined, progress: undefined, status: 'uploading' })
    void upload(entry, entry.file)
  }

  /** 回收 `attIdsInDoc` 之外的条目与本地预览，之后迟到的上传结果不再写回（见 patch）。只在撤销历史跟着清空时调用
   * （整篇重置）：平时文档里删掉的附件节点还可能被撤销、重做带回来，条目得留着。 */
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

  /** 按文档顺序返回已就绪且具备公网地址的附件。 */
  const takeReady = (attIdsInDoc: readonly string[]): ComposerAttachment[] =>
    attIdsInDoc.flatMap((attId) => {
      const entry = entries.get(attId)
      return entry !== undefined && entry.status === 'ready' && entry.url !== undefined
        ? [entry]
        : []
    })

  /** 恢复发送时的附件快照，已就绪条目不重新上传。 */
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

/** 使用方节点的 part；没有自定义节点（`N` 为 never）时这一支也是 never。
 *
 * 取舍：写成普通判别联合 `{kind: 'node'; node: ComposerNode}` 更直白，但首页、对话的序列化（partsContent）
 * 就得为一个永远不会出现的分支写报错。用条件类型让「不支持自定义节点」由类型系统保证，代价是这一行要靠注释读懂。
 * `[N] extends [never]` 加方括号是惯用的「是不是 never」判断，不按联合分发：`N` 是几种节点的联合时得到一个 `node: N` 的 part。 */
type NodePart<N extends ComposerNode> = [N] extends [never]
  ? never
  : { readonly kind: 'node'; readonly node: N }

export type ComposerPart<N extends ComposerNode = never> =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'media'; readonly media: ComposerAttachment }
  | NodePart<N>

/** parts 保留文字、附件与使用方节点的顺序，用于提交；text / media 为气泡占位与失败恢复提供平铺视图。 */
export type ComposerSubmission<N extends ComposerNode = never> = {
  readonly text: string
  readonly media: readonly ComposerAttachment[]
  readonly parts: readonly ComposerPart<N>[]
}
