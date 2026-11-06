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
  editingDisabled: boolean
  editorOf: (content: string) => PromptEditorHandle | undefined
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  onUploaded: (content: string, frame: number, url: string) => void
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
  const [pickerTarget, setPickerTarget] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlyMap<string, PendingImages>>(() => new Map())
  const inFlight = [...pending.values()].reduce((sum, item) => sum + item.count, 0)
  const remaining = () => MAX_REFERENCE_IMAGES - shot.image_urls.length - inFlight

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
      show: (content: string) => setPickerTarget(content),
      close: () => setPickerTarget(null),
      pickExisting,
      upload,
      canUpload: uploadsAllowed && !editingDisabled && remaining() > 0,
    },
    imagesOf,
    drop: {
      blocked: !uploadsAllowed || editingDisabled,
      onFiles: (content: string, files: readonly File[]) =>
        editorOf(content)?.insertFiles(files, 'end'),
      onDirectory: (content: string) => editorOf(content)?.showNotice(DIRECTORY_NOTICE),
    },
    uploading: [...pending.values()].some((item) => item.uploading),
  }
}
