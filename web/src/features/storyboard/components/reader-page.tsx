/** 一组分镜的页面：解析选中的段与帧，组合舞台列、文案列（正文 + 列底的成片区）与添加图片的选择器；
 * 添加图片的流程在 `useFrameAdditions`，替换当前帧的流程在 `useFrameReplacement`。
 * 选中成片时舞台改播它，文案列撤掉选中高亮，点任意一段就回到帧；进行中的上传不受影响，照旧落进原来那段那帧。 */
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
  /** 本组每帧最新图片任务的角标，由工作台按对话级列表算好给下来。 */
  frameBadges: ReadonlyMap<number, FrameBadge>
  editingDisabled: boolean
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  onReplaceFrame: (frame: number, previousUrl: string, url: string) => void
  /** 新图已写进 `content` 段：记下这次上传、选区跟到这帧；不改舞台在显示什么，在放成片就接着放。 */
  onUploaded: (content: string, frame: number, url: string) => void
  onUploadingChange: (group: number, uploading: boolean) => void
  /** 选段或帧：舞台回到帧。 */
  onSelect: (content: string, frame?: number) => void
  onPreview: (media: LightboxMedia) => void
  /** 打开这一帧的编辑器；`open` 决定进去先看哪张：铅笔进底图，角标进那条新结果。 */
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
  /** 文案列底部的成片区，由工作台组好放进来。 */
  takes: ReactNode
  /** 选中的成片与它的操作；没选时舞台显示帧。 */
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
  // 选中的帧；选中成片时它不上舞台，但上传的目标照旧是它。
  const selectedFrame =
    url === undefined || frameNumber === undefined
      ? undefined
      : { badge: frameBadges.get(frameNumber), number: frameNumber, url }
  // 每段一个编辑器；添加图片插在选中那段的光标处。
  const editorsRef = useRef(new Map<string, PromptEditorHandle>())
  const editorRef = (id: string) => (handle: PromptEditorHandle | null) => {
    if (handle === null) editorsRef.current.delete(id)
    else editorsRef.current.set(id, handle)
  }
  // 选同一段不指定帧时停在当前帧：从成片点回原来那段，进行中或失败待重试的上传还认得这个目标。
  const select = (id: string, number?: number) =>
    onSelect(id, number ?? (id === content.id ? frame : undefined))
  const additions = useFrameAdditions({
    content,
    editingDisabled,
    frame,
    insertionAtCursor: () => editorsRef.current.get(content.id)?.getInsertion(),
    onSelect,
    onUpdateShot,
    onUploaded,
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
    // 可聚焦，点舞台空白处也算焦点在工作台里，↑↓ 切组才收得到。
    <section aria-label={`镜头组 ${shot.index}`} className="storyboard-body" tabIndex={-1}>
      <ShotStage
        aspectRatio={aspect_ratio}
        drop={replacement.drop}
        shotIndex={shot.index}
        view={
          take !== undefined
            ? { kind: 'take', ...take }
            : {
                addition: { onRetry: additions.retry, upload: additions.upload },
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
          // 添加图片的入口只在正文里：`@` 选图末格的「+」与粘贴图片。
          add={{ blocker: additions.pickerBlocker, onAdd: additions.picker.show }}
          aspectRatio={aspect_ratio}
          editorRef={editorRef}
          // 选中成片时文案列不标选中：点哪段（包括原来选中的那段）都回到帧。
          frameNumber={take === undefined ? frameNumber : undefined}
          onPasteCapture={additions.onPaste}
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
