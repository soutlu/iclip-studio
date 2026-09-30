/** 替换舞台当前帧的唯一流程：「替换图片」按钮与拖到舞台上都走这里。
 *
 * 一次只传一张。上传只属于发起它的那段的那一帧，不管舞台在显示什么：换段、换帧或这帧的地址变了即作废，迟到的结果不回填；
 * 舞台改放成片不算换目标。成功与失败都 toast，舞台在放成片时画面上的状态看不到。 */

import { useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { toast } from '@/shared/ui/toast'

type Options = {
  /** 选中段的 id；换段即作废进行中的替换。 */
  contentId: string
  /** 选中的帧；没有帧时无可替换，拖放锁定。 */
  frame: { number: number; url: string } | undefined
  editingDisabled: boolean
  /** 舞台在放成片：当前帧不在舞台上，拖放锁定；进行中的替换照旧完成。 */
  showingTake: boolean
  /** 新图已传好：把第 `frame` 帧从 `previousUrl` 换成 `url`。 */
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
  // 只认发起它的目标：换帧后新帧立即可替换，不等副作用清理。
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
      const nextUrl = await uploadMediaFile(file, 'image')
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
    onDirectory: () => toast.error('请拖入一张图片文件，不支持文件夹'),
    onFiles: (files) => {
      const [file] = files
      if (files.length !== 1 || file === undefined) toast.error('每次只能替换一张图片')
      else void replace(file)
    },
  })

  return {
    /** 当前帧正在替换；替换按钮与拖放都按它锁定。 */
    uploading,
    /** 用这个文件替换当前帧；只读、正在替换或没有帧时不做。 */
    replace,
    /** 舞台整块的拖放区。 */
    drop,
  }
}
