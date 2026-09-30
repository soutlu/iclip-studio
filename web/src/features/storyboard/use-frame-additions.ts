/** 往选中段添加图片的唯一流程：正文 `@` 选图末格「+」打开的选择器（关联已有或上传）、在正文里粘贴与失败重试都走这里。
 *
 * 一次只传一张。上传与失败只属于发起它的那段那帧，不管舞台在显示什么：换段、换帧、换组即作废，迟到的结果不回填；
 * 舞台改放成片不算换目标。成功与失败都 toast，舞台在放成片时操作行上的状态看不到。 */

import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { errorMessageOf, UserFacingError } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { toast } from '@/shared/ui/toast'
import { pickerBlockerOf, uploadBlockerOf } from './frame-addition-blocker'
import {
  appendContentImage,
  contentLabel,
  insertContentReference,
  shotContents,
  type ShotContent,
} from './shot-content'
import type { PromptInsertion, Shot } from './shot-document'

/** 选中段这一次新图上传的状态；失败时留着原文件，重试不用再选一遍。 */
export type FrameUpload =
  { kind: 'idle' } | { kind: 'uploading'; progress: number } | { kind: 'failed'; message: string }

type Attempt = { target: string; file: File } & (
  { kind: 'uploading'; progress: number } | { kind: 'failed'; message: string }
)

type Options = {
  shot: Shot
  /** 选中的段；新图与引用都落在它的正文里。 */
  content: ShotContent
  /** 路由里记着的帧（用户选的，不是按正文解析出的）；和段一起定出这次添加的目标，改正文不算换目标。 */
  frame: number | undefined
  editingDisabled: boolean
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  /** 新图地址已写进草稿、引用已插进 `content` 段；`frame` 是它的编号。 */
  onUploaded: (content: string, frame: number, url: string) => void
  /** 关联已有图片后选中那一帧。 */
  onSelect: (content: string, frame?: number) => void
  /** 选中段编辑器里的光标；引用插在这里，编辑器没聚焦过时为 undefined（追加到末尾）。 */
  insertionAtCursor: () => PromptInsertion | undefined
}

export const useFrameAdditions = ({
  content,
  editingDisabled,
  frame,
  insertionAtCursor,
  onSelect,
  onUpdateShot,
  onUploaded,
  shot,
}: Options) => {
  const revisionRef = useRef(0)
  const targetKey = JSON.stringify([shot.index, content.id, frame ?? null])
  const [pickerTarget, setPickerTarget] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  // 状态只认发起它的目标；外部切换目标时立即恢复新目标的可操作状态，不等副作用清理。
  const pickerOpen = pickerTarget === targetKey
  const active = attempt?.target === targetKey ? attempt : null
  const uploading = active?.kind === 'uploading'
  const blockerState = {
    editingDisabled,
    hasPrompt: content.prompt !== undefined,
    imageCount: shot.image_urls.length,
    uploading,
  }
  const pickerBlocker = pickerBlockerOf(blockerState)
  const uploadBlocker = uploadBlockerOf(blockerState)

  useEffect(() => {
    return () => {
      revisionRef.current += 1
      setAttempt(null)
      setPickerTarget(null)
    }
  }, [targetKey])

  const updateTarget = (updater: (current: Shot) => Shot): Shot => {
    const updated = onUpdateShot((current) => {
      const target = shotContents(current).find((item) => item.id === content.id)
      if (target?.prompt === undefined) throw new UserFacingError('所选内容已不存在，请重新选择')
      if (content.timelineIndex !== undefined) {
        const before = shot.prompt.timeline[content.timelineIndex]?.timestamps
        const after = current.prompt.timeline[content.timelineIndex]?.timestamps
        if (before?.[0] !== after?.[0] || before?.[1] !== after?.[1])
          throw new UserFacingError('这个镜头已发生变化，请重新选择')
      }
      return updater(current)
    })
    if (updated === undefined) throw new UserFacingError('镜头组已不存在，请重新选择')
    return updated
  }

  const pickExisting = (number: number, previousUrl: string) => {
    if (editingDisabled) return
    try {
      const insertion = insertionAtCursor()
      updateTarget((current) => {
        if (current.image_urls[number - 1] !== previousUrl)
          throw new UserFacingError('这张图片已发生变化，请重新选择')
        return insertContentReference(current, content.id, number, insertion)
      })
      setPickerTarget(null)
      onSelect(content.id, number)
    } catch (error) {
      toast.error(errorMessageOf(error, '关联图片失败'))
    }
  }

  const upload = async (file: File) => {
    if (uploadBlocker !== undefined) {
      toast.error(uploadBlocker)
      return
    }
    const revision = ++revisionRef.current
    setAttempt({ file, kind: 'uploading', progress: 0, target: targetKey })
    setPickerTarget(null)
    try {
      const newUrl = await uploadMediaFile(file, 'image', {
        onProgress: (ratio) => {
          if (revision !== revisionRef.current) return
          setAttempt({
            file,
            kind: 'uploading',
            progress: Math.round(ratio * 100),
            target: targetKey,
          })
        },
      })
      if (revision !== revisionRef.current) return
      const insertion = insertionAtCursor()
      const updated = updateTarget((current) =>
        appendContentImage(current, content.id, newUrl, insertion),
      )
      setAttempt(null)
      onUploaded(content.id, updated.image_urls.length, newUrl)
      toast(`图片已添加到${contentLabel(content)}`)
    } catch (error) {
      const message = errorMessageOf(error, '上传失败')
      // 没作废就留着失败态与原文件，回到这段这帧还能重试。
      if (revision === revisionRef.current)
        setAttempt({ file, kind: 'failed', message, target: targetKey })
      toast.error(message)
    }
  }

  /** 挂在文案列的捕获阶段：剪贴板里有文件才接管，并拦住编辑器自己的粘贴；纯文字照旧交给编辑器。 */
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    const [file] = files
    if (uploadBlocker !== undefined) toast.error(uploadBlocker)
    else if (files.length !== 1 || file === undefined) toast.error('每次只能添加一张图片')
    else void upload(file)
  }

  const state: FrameUpload =
    active === null
      ? { kind: 'idle' }
      : active.kind === 'uploading'
        ? { kind: 'uploading', progress: active.progress }
        : { kind: 'failed', message: active.message }

  return {
    /** 「+」被挡住的原因；满了不挡，选择器里仍能关联已有图片。 */
    pickerBlocker,
    /** 直接上传新图被挡住的原因，选择器的「上传图片」也按它置灰。 */
    uploadBlocker,
    picker: {
      open: pickerOpen,
      show: () => {
        if (pickerBlocker === undefined) setPickerTarget(targetKey)
      },
      close: () => setPickerTarget(null),
      pickExisting,
      upload,
    },
    upload: state,
    uploading,
    retry: () => {
      if (active?.kind === 'failed') void upload(active.file)
    },
    onPaste,
  }
}
