/** 往段里添加图片：正文 `@` 选图末格「+」打开的选择器（关联已有或上传），以及各段正文里在途的图片。
 *
 * 粘贴、拖放与选择器上传都落成那段正文里的附件 chip（见 `PromptEditor`），可以同时传几张；图归落下它的那段：
 * 换段、换帧、舞台改放成片都不影响，传好照旧落回那里。换组（整页卸载）或那段正文被外面改掉（编辑器整篇重置）时
 * chip 丢弃，迟到的结果不回填。张数上限按本组算：已有的加各段在途的不超过 30 张。 */

import { useState } from 'react'
import { UserFacingError } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { DIRECTORY_NOTICE } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import type { PendingImages, PromptEditorHandle, PromptImages } from './components/prompt-editor'
import { appendContentImage } from './shot-content'
import type { Shot } from './shot-document'
import { MAX_REFERENCE_IMAGES } from './shots'

type Options = {
  shot: Shot
  /** 只读或正在提交出片，整页不能改。 */
  editingDisabled: boolean
  /** 各段的正文编辑器。 */
  editorOf: (content: string) => PromptEditorHandle | undefined
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  /** 新图地址已写进草稿、引用已插进 `content` 段；`frame` 是它的编号。 */
  onUploaded: (content: string, frame: number, url: string) => void
  /** 关联已有图片后选中那一帧。 */
  onSelect: (content: string, frame?: number) => void
}

const GONE = '所选内容已不存在，请重新选择'

export const useFrameAdditions = ({
  editingDisabled,
  editorOf,
  onSelect,
  onUpdateShot,
  onUploaded,
  shot,
}: Options) => {
  const { data: user } = useUser()
  const uploadsAllowed = hasPermission(user, PERMISSION.uploadsWrite)
  // 选择器从哪段的 `@` 打开，关联与上传都落回那段。
  const [pickerTarget, setPickerTarget] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlyMap<string, PendingImages>>(() => new Map())
  const inFlight = [...pending.values()].reduce((sum, item) => sum + item.count, 0)
  const remaining = () => MAX_REFERENCE_IMAGES - shot.image_urls.length - inFlight

  /** 关掉选择器，交回发起它的那段编辑器；那段已经不在了就说明原因。 */
  const takeTarget = (): [string, PromptEditorHandle] | undefined => {
    const target = pickerTarget
    setPickerTarget(null)
    const editor = target === null ? undefined : editorOf(target)
    if (target === null || editor === undefined) {
      toast.error(GONE)
      return undefined
    }
    return [target, editor]
  }

  const pickExisting = (number: number, previousUrl: string) => {
    if (editingDisabled) return
    if (shot.image_urls[number - 1] !== previousUrl) {
      toast.error('该图片已发生变化，请重新选择')
      return
    }
    const taken = takeTarget()
    if (taken === undefined) return
    const [target, editor] = taken
    editor.insertFrame(number)
    onSelect(target, number)
  }

  const upload = (file: File) => {
    if (editingDisabled) return
    takeTarget()?.[1].insertFiles([file], 'selection')
  }

  /** 第 `content` 段正文收图片要的；没有上传权限时不收。 */
  const imagesOf = (content: string): PromptImages | undefined =>
    uploadsAllowed
      ? {
          land: (url, insertion) => {
            const updated = onUpdateShot((current) =>
              appendContentImage(current, content, url, insertion),
            )
            if (updated === undefined) throw new UserFacingError('镜头组已不存在，请重新选择')
            const frame = updated.image_urls.length
            onUploaded(content, frame, url)
            return frame
          },
          onPendingChange: (next) =>
            setPending((previous) => {
              const current = previous.get(content)
              if (current?.count === next.count && current.uploading === next.uploading)
                return previous
              const updated = new Map(previous)
              if (next.count === 0) updated.delete(content)
              else updated.set(content, next)
              return updated
            }),
          remaining,
        }
      : undefined

  return {
    picker: {
      open: pickerTarget !== null,
      /** 从第 `content` 段正文的 `@` 打开。 */
      show: (content: string) => setPickerTarget(content),
      close: () => setPickerTarget(null),
      pickExisting,
      upload,
      /** 选择器里「上传图片」可不可用：满了仍能关联已有图片。 */
      canUpload: uploadsAllowed && !editingDisabled && remaining() > 0,
    },
    imagesOf,
    /** 段卡上的拖放：落在正文以外的地方接到这段末尾。 */
    drop: {
      blocked: !uploadsAllowed || editingDisabled,
      onFiles: (content: string, files: readonly File[]) =>
        editorOf(content)?.insertFiles(files, 'end'),
      onDirectory: (content: string) => editorOf(content)?.showNotice(DIRECTORY_NOTICE),
    },
    /** 有图片正在上传：出片要等它们传完。 */
    uploading: [...pending.values()].some((item) => item.uploading),
  }
}
