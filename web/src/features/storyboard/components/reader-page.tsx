import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react'
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
} from '../shot-content'
import { useFrameAdditions } from '../use-frame-additions'
import { useFrameReplacement } from '../use-frame-replacement'
import { FrameAssignmentPicker } from './frame-assignment-picker'
import type { PromptEditorHandle } from './prompt-editor'
import { ShotScript } from './shot-script'
import { ShotStage, type TakeView } from './shot-stage'

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
  takes: ReactNode
  take: Omit<TakeView, 'kind'> | undefined
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
  take,
  takes,
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
  const editorsRef = useRef(new Map<string, PromptEditorHandle>())
  const editorRef = (id: string) => (handle: PromptEditorHandle | null) => {
    if (handle === null) editorsRef.current.delete(id)
    else editorsRef.current.set(id, handle)
  }
  const select = (id: string, number?: number) =>
    onSelect(id, number ?? (id === content.id ? frame : undefined))
  const additions = useFrameAdditions({
    editingDisabled,
    editorOf: (id) => editorsRef.current.get(id),
    onSelect,
    onUpdateShot,
    onUploaded: (id, number, landed) => onUploaded(id, number, landed, id === content.id),
    shot,
  })
  const replacement = useFrameReplacement({
    contentId: content.id,
    editingDisabled,
    frame: selectedFrame,
    onReplace: onReplaceFrame,
    showingTake: take !== undefined,
  })
  const reportUploading = useEffectEvent((busy: boolean) => onUploadingChange(shot.index, busy))
  useEffect(() => {
    reportUploading(additions.uploading || replacement.uploading)
    return () => reportUploading(false)
  }, [additions.uploading, replacement.uploading])

  const preview = (number: number, frameUrl: string) =>
    onPreview({ kind: 'image', name: `镜头组 ${shot.index} 第 ${number} 帧`, url: frameUrl })
  const previous = adjacentFrame(content, frameNumber, -1)
  const next = adjacentFrame(content, frameNumber, 1)
  const fresh = new Set(
    [...frameBadges].flatMap(([number, badge]) => (badge.kind === 'result' ? [number] : [])),
  )

  return (
    <section aria-label={`镜头组 ${shot.index}`} className="storyboard-body" tabIndex={-1}>
      <ShotStage
        aspectRatio={aspect_ratio}
        drop={replacement.drop}
        shotIndex={shot.index}
        view={
          take !== undefined
            ? { kind: 'take', ...take }
            : {
                disabled: editingDisabled,
                frame: selectedFrame,
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
                kind: 'frame',
                onEditFrame,
                onNext: next === undefined ? undefined : () => select(content.id, next),
                onOpenFrame: (item) => preview(item.number, item.url),
                onPrevious: previous === undefined ? undefined : () => select(content.id, previous),
                onReplaceFile: (file) => void replacement.replace(file),
                replacing: replacement.uploading,
              }
        }
      />
      <div aria-hidden className="storyboard-divider" />
      <div className="storyboard-script">
        <ShotScript
          add={additions.picker.show}
          aspectRatio={aspect_ratio}
          drop={additions.drop}
          editorRef={editorRef}
          frameNumber={take === undefined ? frameNumber : undefined}
          images={additions.imagesOf}
          onSelect={select}
          onUpdateShot={onUpdateShot}
          readOnly={editingDisabled}
          segments={scriptSegments(contents)}
          selectedId={take === undefined ? content.id : undefined}
          shot={shot}
        />
        {takes}
      </div>
      <FrameAssignmentPicker
        canUpload={additions.picker.canUpload}
        disabled={editingDisabled}
        frames={shot.image_urls}
        onClose={additions.picker.close}
        onPickExisting={additions.picker.pickExisting}
        onUpload={additions.picker.upload}
        open={additions.picker.open}
      />
    </section>
  )
}
