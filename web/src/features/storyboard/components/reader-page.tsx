/** 一组分镜的页面：解析选中的段与帧，组合舞台与文案列，并管添加图片（关联已有或上传）的流程。 */
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { errorMessageOf, UserFacingError } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import type { LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import type { FrameBadge } from '../frame-status'
import { type Shot } from '../shot-document'
import {
  adjacentFrame,
  appendContentImage,
  insertContentReference,
  resolveShotSelection,
  scriptSegments,
  sharedFrameCaption,
  shotContents,
} from '../shot-content'
import { MAX_REFERENCE_IMAGES } from '../shots'
import { FrameAssignmentPicker } from './frame-assignment-picker'
import type { PromptEditorHandle } from './prompt-editor'
import { ShotScript } from './shot-script'
import { ShotStage } from './shot-stage'

type ReaderPageProps = {
  shot: Shot
  aspect_ratio: string
  content: string | undefined
  frame: number | undefined
  /** 本组每帧最新图片任务的角标，由工作台按对话级列表算好给下来。 */
  frameBadges: ReadonlyMap<number, FrameBadge>
  editingDisabled: boolean
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  onReplaceFrame: (frame: number, previousUrl: string, url: string) => void
  onUploaded: (frame: number, url: string) => void
  onUploadingChange: (group: number, uploading: boolean) => void
  onSelect: (content: string, frame?: number) => void
  onPreview: (media: LightboxMedia) => void
  /** 打开这一帧的编辑器；`open` 决定进去先看哪张：铅笔进底图，角标进那条新结果。 */
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
}

export function ReaderPage({
  aspect_ratio,
  content: requestedContent,
  editingDisabled,
  frame,
  frameBadges,
  onEditFrame,
  onSelect,
  onPreview,
  onReplaceFrame,
  onUpdateShot,
  onUploaded,
  onUploadingChange,
  shot,
}: ReaderPageProps) {
  const contents = shotContents(shot)
  const { content, frame: frameNumber } = resolveShotSelection(contents, {
    content: requestedContent,
    frame,
  })
  const url = frameNumber === undefined ? undefined : shot.image_urls[frameNumber - 1]
  // 每段一个编辑器；添加图片插在选中那段的光标处。
  const editorsRef = useRef(new Map<string, PromptEditorHandle>())
  const editorRef = (id: string) => (handle: PromptEditorHandle | null) => {
    if (handle === null) editorsRef.current.delete(id)
    else editorsRef.current.set(id, handle)
  }
  const insertionAtCursor = () => editorsRef.current.get(content.id)?.getInsertion()
  const uploadRevisionRef = useRef(0)
  const targetKey = JSON.stringify([shot.index, content.id])
  const [pickerTarget, setPickerTarget] = useState<string | null>(null)
  const [uploadTarget, setUploadTarget] = useState<string | null>(null)
  // 操作只属于发起它的内容；外部切换目标时立即恢复新目标的可操作状态。
  const pickerOpen = pickerTarget === targetKey
  const uploading = uploadTarget === targetKey
  const [replacing, setReplacing] = useState(false)
  const reportUploading = useEffectEvent((busy: boolean) => onUploadingChange(shot.index, busy))
  useEffect(() => {
    reportUploading(uploading || replacing)
    return () => reportUploading(false)
  }, [uploading, replacing])
  useEffect(() => {
    return () => {
      uploadRevisionRef.current += 1
      setUploadTarget(null)
      setPickerTarget(null)
    }
  }, [targetKey])

  const select = (id: string, number?: number) => {
    uploadRevisionRef.current += 1
    setUploadTarget(null)
    setPickerTarget(null)
    onSelect(id, number)
  }

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
      select(content.id, number)
    } catch (error) {
      toast.error(errorMessageOf(error, '关联图片失败'))
    }
  }
  const upload = async (file: File) => {
    if (editingDisabled || uploading) return
    const revision = ++uploadRevisionRef.current
    setUploadTarget(targetKey)
    setPickerTarget(null)
    try {
      const newUrl = await uploadMediaFile(file, 'image')
      if (revision !== uploadRevisionRef.current) return
      const insertion = insertionAtCursor()
      const updated = updateTarget((current) =>
        appendContentImage(current, content.id, newUrl, insertion),
      )
      onUploaded(updated.image_urls.length, newUrl)
      select(content.id, updated.image_urls.length)
    } catch (error) {
      // 切走之后结果可以不要，失败必须让人知道。
      toast.error(errorMessageOf(error, '上传失败'))
    } finally {
      if (revision === uploadRevisionRef.current) setUploadTarget(null)
    }
  }
  const previous = adjacentFrame(content, frameNumber, -1)
  const next = adjacentFrame(content, frameNumber, 1)
  const stageFrame =
    url === undefined || frameNumber === undefined
      ? undefined
      : {
          badge: frameBadges.get(frameNumber),
          caption: sharedFrameCaption(contents, frameNumber),
          number: frameNumber,
          url,
        }

  return (
    <section aria-label={`镜头组 ${shot.index}`} className="storyboard-body">
      <ShotStage
        aspectRatio={aspect_ratio}
        disabled={editingDisabled}
        frame={stageFrame}
        // 换段就重挂：进行中的替换上传属于原来那段，结果不要了。
        key={content.id}
        onAddImage={
          content.prompt === undefined || uploading ? undefined : () => setPickerTarget(targetKey)
        }
        onEditFrame={onEditFrame}
        onNext={next === undefined ? undefined : () => select(content.id, next)}
        onOpenFrame={(item) =>
          onPreview({
            kind: 'image',
            name: `镜头组 ${shot.index} 第 ${item.number} 帧`,
            url: item.url,
          })
        }
        onPrevious={previous === undefined ? undefined : () => select(content.id, previous)}
        onReplaceFrame={onReplaceFrame}
        onReplacingChange={setReplacing}
        shotIndex={shot.index}
        uploadingNewImage={uploading}
      />
      <div className="storyboard-script">
        <ShotScript
          editorRef={editorRef}
          frameNumber={frameNumber}
          onSelect={select}
          onUpdateShot={onUpdateShot}
          readOnly={editingDisabled}
          segments={scriptSegments(contents)}
          selectedId={content.id}
          shot={shot}
        />
      </div>
      <FrameAssignmentPicker
        disabled={editingDisabled}
        frames={shot.image_urls}
        onClose={() => setPickerTarget(null)}
        onPickExisting={pickExisting}
        onUpload={upload}
        open={pickerOpen}
        canUpload={shot.image_urls.length < MAX_REFERENCE_IMAGES}
      />
    </section>
  )
}
