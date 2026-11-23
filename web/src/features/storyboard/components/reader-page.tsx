import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import type { LightboxMedia } from '@/shared/ui/media-lightbox'
import type { FrameBadge } from '../frame-status'
import { type Shot } from '../shot-document'
import {
  adjacentFrame,
  contentAfterPickingFrame,
  framePosition,
  frameUsage,
  resolveShotSelection,
  scriptSegments,
  shotContents,
  type ShotContent,
} from '../shot-content'
import { useFrameAdditions } from '../use-frame-additions'
import { useFrameReplacement } from '../use-frame-replacement'
import { FrameAssignmentPicker } from './frame-assignment-picker'
import type { StageFrameInfo } from './frame-stage-bar'
import type { PromptEditorHandle } from './prompt-editor'
import { ReaderLayout } from './reader-layout'
import { ShotScript } from './shot-script'
import { ShotStage, type FrameView, type TakeView } from './shot-stage'

type ReaderPageProps = {
  shot: Shot
  aspect_ratio: string
  content: string | undefined
  frame: number | undefined
  frameBadges: ReadonlyMap<number, FrameBadge>
  editingDisabled: boolean
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  onReplaceFrame: (frame: number, previousUrl: string, url: string) => void
  onUploaded: (content: string, frame: number, url: string, follow: boolean) => void
  onUploadingChange: (group: number, uploading: boolean) => void
  onSelect: (content: string, frame?: number) => void
  onPreview: (media: LightboxMedia) => void
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
  toolbar: ReactNode
  takes: ReactNode
  take: Omit<TakeView, 'kind'> | undefined
}

type UploadingParts = { frame: boolean; script: boolean }

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
  take,
  takes,
  toolbar,
}: ReaderPageProps) {
  const contents = shotContents(shot)
  const { content, frame: frameNumber } = resolveShotSelection(contents, {
    content: requestedContent,
    frame,
  })
  const url = frameNumber === undefined ? undefined : shot.image_urls[frameNumber - 1]
  const selectedFrame =
    url === undefined || frameNumber === undefined
      ? undefined
      : { badge: frameBadges.get(frameNumber), number: frameNumber, url }
  const select = (id: string, number?: number) =>
    onSelect(id, number ?? (id === content.id ? frame : undefined))

  // 舞台替换帧与文案加图分别维护上传态，取并集作为当前镜头组的整体上传状态。
  const [uploading, setUploading] = useState<UploadingParts>({ frame: false, script: false })
  const markUploading = (part: keyof UploadingParts) => (busy: boolean) =>
    setUploading((current) => (current[part] === busy ? current : { ...current, [part]: busy }))
  const busy = uploading.frame || uploading.script
  const reportUploading = useEffectEvent((group: number, value: boolean) =>
    onUploadingChange(group, value),
  )
  useEffect(() => {
    reportUploading(shot.index, busy)
    return () => reportUploading(shot.index, false)
  }, [shot.index, busy])

  const preview = (number: number, frameUrl: string) =>
    onPreview({ kind: 'image', name: `镜头组 ${shot.index} 第 ${number} 帧`, url: frameUrl })
  const previous = adjacentFrame(content, frameNumber, -1)
  const next = adjacentFrame(content, frameNumber, 1)
  const fresh = new Set(
    [...frameBadges].flatMap(([number, badge]) => (badge.kind === 'result' ? [number] : [])),
  )

  return (
    <ReaderLayout
      group={shot.index}
      script={
        <ReaderScript
          aspectRatio={aspect_ratio}
          contentId={content.id}
          editingDisabled={editingDisabled}
          frameNumber={take === undefined ? frameNumber : undefined}
          onSelect={onSelect}
          onSelectContent={select}
          onUpdateShot={onUpdateShot}
          onUploaded={onUploaded}
          onUploadingChange={markUploading('script')}
          segments={scriptSegments(contents)}
          selectedId={take === undefined ? content.id : undefined}
          shot={shot}
        />
      }
      stage={
        <ReaderStage
          aspectRatio={aspect_ratio}
          contentId={content.id}
          editingDisabled={editingDisabled}
          frame={selectedFrame}
          frameView={{
            gallery: {
              current: frameNumber,
              fresh,
              onPick: (number) => {
                const target = contentAfterPickingFrame(contents, content.id, number)
                if (target !== undefined) select(target, number)
              },
              onPreview: (number) => {
                const frameUrl = shot.image_urls[number - 1]
                if (frameUrl !== undefined) preview(number, frameUrl)
              },
              position: framePosition(content, frameNumber),
              urls: shot.image_urls,
              usageOf: (number) => frameUsage(contents, number),
            },
            onEditFrame,
            onNext: next === undefined ? undefined : () => select(content.id, next),
            onOpenFrame: (item) => preview(item.number, item.url),
            onPrevious: previous === undefined ? undefined : () => select(content.id, previous),
          }}
          onReplaceFrame={onReplaceFrame}
          onUploadingChange={markUploading('frame')}
          shotIndex={shot.index}
          take={take}
        />
      }
      takes={takes}
      toolbar={toolbar}
    />
  )
}

const useReportUploading = (uploading: boolean, report: (uploading: boolean) => void) => {
  const onChange = useEffectEvent(report)
  useEffect(() => {
    onChange(uploading)
    return () => onChange(false)
  }, [uploading])
}

type ReaderStageProps = {
  aspectRatio: string
  shotIndex: number
  contentId: string
  editingDisabled: boolean
  frame: StageFrameInfo | undefined
  frameView: Pick<FrameView, 'gallery' | 'onEditFrame' | 'onNext' | 'onOpenFrame' | 'onPrevious'>
  take: Omit<TakeView, 'kind'> | undefined
  onReplaceFrame: (frame: number, previousUrl: string, url: string) => void
  onUploadingChange: (uploading: boolean) => void
}

/** 舞台区域：支持拖放或选择文件替换当前帧，上传状态随镜头组重挂重置。 */
function ReaderStage({
  aspectRatio,
  contentId,
  editingDisabled,
  frame,
  frameView,
  onReplaceFrame,
  onUploadingChange,
  shotIndex,
  take,
}: ReaderStageProps) {
  const replacement = useFrameReplacement({
    contentId,
    editingDisabled,
    frame,
    onReplace: onReplaceFrame,
    showingTake: take !== undefined,
  })
  useReportUploading(replacement.uploading, onUploadingChange)
  return (
    <ShotStage
      aspectRatio={aspectRatio}
      drop={replacement.drop}
      shotIndex={shotIndex}
      view={
        take !== undefined
          ? { kind: 'take', ...take }
          : {
              ...frameView,
              disabled: editingDisabled,
              frame,
              kind: 'frame',
              onReplaceFile: (file) => void replacement.replace(file),
              replacing: replacement.uploading,
            }
      }
    />
  )
}

type ReaderScriptProps = {
  shot: Shot
  aspectRatio: string
  contentId: string
  segments: readonly ShotContent[]
  selectedId: string | undefined
  frameNumber: number | undefined
  editingDisabled: boolean
  onSelect: (content: string, frame?: number) => void
  onSelectContent: (content: string, frame?: number) => void
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  onUploaded: (content: string, frame: number, url: string, follow: boolean) => void
  onUploadingChange: (uploading: boolean) => void
}

/** 脚本区域：承载文案编辑与参考图添加，上传状态随镜头组重挂重置。 */
function ReaderScript({
  aspectRatio,
  contentId,
  editingDisabled,
  frameNumber,
  onSelect,
  onSelectContent,
  onUpdateShot,
  onUploaded,
  onUploadingChange,
  segments,
  selectedId,
  shot,
}: ReaderScriptProps) {
  const editorsRef = useRef(new Map<string, PromptEditorHandle>())
  const editorRef = (id: string) => (handle: PromptEditorHandle | null) => {
    if (handle === null) editorsRef.current.delete(id)
    else editorsRef.current.set(id, handle)
  }
  const additions = useFrameAdditions({
    editingDisabled,
    editorOf: (id) => editorsRef.current.get(id),
    onSelect,
    onUpdateShot,
    onUploaded: (id, number, landed) => onUploaded(id, number, landed, id === contentId),
    shot,
  })
  useReportUploading(additions.uploading, onUploadingChange)
  return (
    <>
      <ShotScript
        add={additions.picker.show}
        aspectRatio={aspectRatio}
        drop={additions.drop}
        editorRef={editorRef}
        frameNumber={frameNumber}
        images={additions.imagesOf}
        onSelect={onSelectContent}
        onUpdateShot={onUpdateShot}
        readOnly={editingDisabled}
        segments={segments}
        selectedId={selectedId}
        shot={shot}
      />
      <FrameAssignmentPicker
        canUpload={additions.picker.canUpload}
        disabled={editingDisabled}
        frames={shot.image_urls}
        onClose={additions.picker.close}
        onPickExisting={additions.picker.pickExisting}
        onUpload={additions.picker.upload}
        open={additions.picker.open}
      />
    </>
  )
}
