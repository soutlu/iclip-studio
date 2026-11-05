import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_VIDEO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { mintUuid } from '@/shared/lib/uuid'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { toast } from '@/shared/ui/toast'
import { createReference, referenceQueryKeys } from './references.api'

export const ONLY_VIDEOS_HINT = '仅支持 MP4 或 MOV 视频，其他文件无法上传'

const VIDEO_TYPES = MEDIA_VIDEO_ACCEPT.split(',')

export const splitVideoFiles = (files: readonly File[]): { videos: File[]; rejected: number } => {
  const videos = files.filter((file) => VIDEO_TYPES.includes(file.type))
  return { rejected: files.length - videos.length, videos }
}

export const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable]') !== null)

export type PendingUpload = { key: string; name: string; progress: number }

type ReferenceUploadOptions = {
  enabled: boolean
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
      queryClient.setQueryData(referenceQueryKeys.detail(reference.id), reference)
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
    dragHandlers: enabled ? drop.dragHandlers : {},
    dragOver: drop.dragOver,
    pending,
    uploadVideos,
  }
}
