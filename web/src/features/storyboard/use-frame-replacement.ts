import { useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { toast } from '@/shared/ui/toast'

type Options = {
  contentId: string
  frame: { number: number; url: string } | undefined
  editingDisabled: boolean
  showingTake: boolean
  onReplace: (frame: number, previousUrl: string, url: string) => void
}

export const useFrameReplacement = ({
  contentId,
  editingDisabled,
  frame,
  onReplace,
  showingTake,
}: Options) => {
  const target = frame === undefined ? null : JSON.stringify([contentId, frame.number, frame.url])
  const revisionRef = useRef(0)
  const [pending, setPending] = useState<string | null>(null)
  const uploading = pending !== null && pending === target

  useEffect(() => {
    return () => {
      revisionRef.current += 1
      setPending(null)
    }
  }, [target])

  const replace = async (file: File) => {
    if (editingDisabled || uploading || frame === undefined) return
    const { number, url } = frame
    const revision = ++revisionRef.current
    setPending(target)
    try {
      const { url: nextUrl } = await uploadMediaFile(file, 'image')
      if (revision === revisionRef.current) {
        onReplace(number, url, nextUrl)
        toast(`已替换第 ${number} 帧`)
      }
    } catch (error) {
      toast.error(errorMessageOf(error, '上传失败'))
    } finally {
      if (revision === revisionRef.current) setPending(null)
    }
  }

  const drop = useFileDropTarget({
    blocked: editingDisabled || uploading || frame === undefined || showingTake,
    onDirectory: () => toast.error('无法用文件夹替换图片；请拖入一张图片文件'),
    onFiles: (files) => {
      const [file] = files
      if (files.length !== 1 || file === undefined)
        toast.error('已选择多个文件，无法替换；请仅选择一张图片')
      else void replace(file)
    },
  })

  return {
    uploading,
    replace,
    drop,
  }
}
