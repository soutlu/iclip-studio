/** 一组分镜的页面：解析选中的段与帧，组合舞台、文案列（正文 + 列底的成片区）与添加图片的选择器；添加图片的流程在 `useFrameAdditions`。 */
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
} from '../shot-content'
import { useFrameAdditions } from '../use-frame-additions'
import { FrameAssignmentPicker } from './frame-assignment-picker'
import type { FrameAdd } from './frame-tile'
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
  /** 文案列底部的成片区，由工作台组好放进来。 */
  takes: ReactNode
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
  takes,
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
  const additions = useFrameAdditions({
    content,
    editingDisabled,
    insertionAtCursor: () => editorsRef.current.get(content.id)?.getInsertion(),
    onSelect,
    onUpdateShot,
    onUploaded,
    shot,
  })
  const select = additions.select
  // 「+」的唯一入口：舞台工具组、帧计数弹层与正文 `@` 选图的末格都用它。
  const add: FrameAdd = { blocker: additions.pickerBlocker, onAdd: additions.picker.show }
  const [replacing, setReplacing] = useState(false)
  const reportUploading = useEffectEvent((busy: boolean) => onUploadingChange(shot.index, busy))
  useEffect(() => {
    reportUploading(additions.uploading || replacing)
    return () => reportUploading(false)
  }, [additions.uploading, replacing])

  const preview = (number: number, frameUrl: string) =>
    onPreview({ kind: 'image', name: `镜头组 ${shot.index} 第 ${number} 帧`, url: frameUrl })
  const previous = adjacentFrame(content, frameNumber, -1)
  const next = adjacentFrame(content, frameNumber, 1)
  const fresh = new Set(
    [...frameBadges].flatMap(([number, badge]) => (badge.kind === 'result' ? [number] : [])),
  )

  return (
    // 可聚焦，点舞台空白处也算焦点在工作台里，粘贴才落得到这里。
    <section
      aria-label={`镜头组 ${shot.index}`}
      className="storyboard-body"
      onPasteCapture={additions.onPaste}
      tabIndex={-1}
    >
      <ShotStage
        addition={{
          ...add,
          drop: additions.drop,
          onRetry: additions.retry,
          upload: additions.upload,
        }}
        aspectRatio={aspect_ratio}
        disabled={editingDisabled}
        frame={
          url === undefined || frameNumber === undefined
            ? undefined
            : { badge: frameBadges.get(frameNumber), number: frameNumber, url }
        }
        gallery={{
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
        }}
        // 换段就重挂：进行中的替换上传属于原来那段，结果不要了。
        key={content.id}
        onEditFrame={onEditFrame}
        onNext={next === undefined ? undefined : () => select(content.id, next)}
        onOpenFrame={(item) => preview(item.number, item.url)}
        onPrevious={previous === undefined ? undefined : () => select(content.id, previous)}
        onReplaceFrame={onReplaceFrame}
        onReplacingChange={setReplacing}
        shotIndex={shot.index}
      />
      <div className="storyboard-script">
        <ShotScript
          add={add}
          aspectRatio={aspect_ratio}
          editorRef={editorRef}
          frameNumber={frameNumber}
          onSelect={select}
          onUpdateShot={onUpdateShot}
          readOnly={editingDisabled}
          segments={scriptSegments(contents)}
          selectedId={content.id}
          shot={shot}
        />
        {takes}
      </div>
      <FrameAssignmentPicker
        canUpload={additions.uploadBlocker === undefined}
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
