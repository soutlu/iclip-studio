/** 参考视频的上传：选文件、整页拖放、页面粘贴三个入口走同一个 `uploadVideos`，一个文件一张卡。
 *
 * 每个文件先直传对象存储并确认，再用上传 id 建行；同一条视频之前传过时服务端交回原来那一行（移除过的
 * 会回到资料库），这时提示一句并打开它。不是 MP4 / MOV 的文件和文件夹不传，给一句提示，其余照传。 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_VIDEO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { mintUuid } from '@/shared/lib/uuid'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { toast } from '@/shared/ui/toast'
import { createReference, referenceQueryKeys } from './references.api'

/** 收不下的文件统一这一句。 */
export const ONLY_VIDEOS_HINT = '仅支持 MP4 或 MOV 视频，其他文件无法上传'

const VIDEO_TYPES = MEDIA_VIDEO_ACCEPT.split(',')

/** 按 MIME 分出能传的视频；`rejected` 是被挑掉的个数。 */
export const splitVideoFiles = (files: readonly File[]): { videos: File[]; rejected: number } => {
  const videos = files.filter((file) => VIDEO_TYPES.includes(file.type))
  return { rejected: files.length - videos.length, videos }
}

/** 焦点在输入框、文本框或可编辑区域里：粘贴归它，不当上传。 */
export const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable]') !== null)

/** 一张正在上传的卡：还没建行，只有文件名和直传进度（0–1）。 */
export type PendingUpload = { key: string; name: string; progress: number }

type ReferenceUploadOptions = {
  /** 这位读者能加参考视频；为假时三个入口都不接。 */
  enabled: boolean
  /** 传了一条已经在资料库里的视频：打开原来那一条。 */
  onOpenExisting: (id: string) => void
}

export const useReferenceUpload = ({ enabled, onOpenExisting }: ReferenceUploadOptions) => {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<readonly PendingUpload[]>([])

  const setProgress = (key: string, progress: number) =>
    setPending((prev) => prev.map((item) => (item.key === key ? { ...item, progress } : item)))

  const uploadOne = async (file: File) => {
    const key = mintUuid()
    setPending((prev) => [{ key, name: file.name, progress: 0 }, ...prev])
    try {
      const { uploadId } = await uploadMediaFile(file, 'video', {
        onProgress: (ratio) => setProgress(key, ratio),
      })
      const { reference, created } = await createReference(uploadId)
      // 新行读回来再撤掉上传卡，前面那张卡不会先空一下。
      await queryClient.invalidateQueries({ queryKey: referenceQueryKeys.all })
      if (!created) {
        toast('该视频此前已上传，已打开其详情')
        onOpenExisting(reference.id)
      }
    } catch (error) {
      toast.error(`${file.name} ${errorMessageOf(error, '上传失败')}`)
    } finally {
      setPending((prev) => prev.filter((item) => item.key !== key))
    }
  }

  /** 三个入口的共同出口；`skipped` 是入口自己已经滤掉的（如文件夹），与非视频合成一句提示。 */
  const uploadVideos = (files: readonly File[], skipped = 0) => {
    if (!enabled) return
    const { videos, rejected } = splitVideoFiles(files)
    if (rejected + skipped > 0) toast.error(ONLY_VIDEOS_HINT)
    for (const file of videos) void uploadOne(file)
  }

  const drop = useFileDropTarget({
    blocked: !enabled,
    onDirectory: (files) => uploadVideos(files, 1),
    onFiles: (files) => uploadVideos(files),
  })

  // 页面上任意处粘贴：剪贴板里有文件才接，文字与链接照常交给别处；输入框里与弹窗里不接。
  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length === 0 || isEditableTarget(event.target)) return
    if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== null) return
    event.preventDefault()
    uploadVideos(files)
  })
  useEffect(() => {
    if (!enabled) return
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [enabled])

  return {
    /** 展开到整页容器上；锁定时不展开。 */
    dragHandlers: enabled ? drop.dragHandlers : {},
    dragOver: drop.dragOver,
    pending,
    uploadVideos,
  }
}
