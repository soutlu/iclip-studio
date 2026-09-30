/** 舞台：当前帧按画幅 contain 居中；画面上挂 @N 角标、帧工具、上一帧 / 下一帧、帧计数与上传状态。整块是添加图片的拖放区。 */

import type { CSSProperties } from 'react'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import type { useFileDropTarget } from '@/shared/ui/file-drop'
import type { FrameBadge } from '../frame-status'
import type { FrameUpload } from '../use-frame-additions'
import { BlockedReason } from './blocked-reason'
import { FrameCounter, type FrameGallery } from './frame-counter'
import { FramePreview } from './frame-preview'
import { StageUploadStatus } from './stage-upload-status'
import { workbenchControl } from './workbench-control'

export type StageFrame = {
  number: number
  url: string
  /** 这一帧最新图片任务的角标；没有或已看过就不给。 */
  badge: FrameBadge | undefined
}

/** 往选中段添加图片的入口与状态，都来自 `useFrameAdditions`。 */
export type StageAddition = {
  /** 「+」被挡住的原因；有它时置灰并说明。 */
  blocker: string | undefined
  onAdd: () => void
  upload: FrameUpload
  onRetry: () => void
  drop: ReturnType<typeof useFileDropTarget>
}

type ShotStageProps = {
  shotIndex: number
  aspectRatio: string
  /** 当前段没有帧时为 undefined，舞台留空并保留添加入口。 */
  frame: StageFrame | undefined
  disabled: boolean
  /** 上一帧、下一帧；到头的一侧不给，按钮置灰。 */
  onPrevious: (() => void) | undefined
  onNext: (() => void) | undefined
  gallery: FrameGallery
  addition: StageAddition
  onOpenFrame: (frame: StageFrame) => void
  /** 打开这一帧的编辑器；`open` 决定进去先看哪张：铅笔进底图，角标进那条新结果。 */
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
  onReplaceFrame: (frame: number, previousUrl: string, url: string) => void
  onReplacingChange: (replacing: boolean) => void
}

export function ShotStage({
  addition,
  aspectRatio,
  disabled,
  frame,
  gallery,
  onEditFrame,
  onNext,
  onOpenFrame,
  onPrevious,
  onReplaceFrame,
  onReplacingChange,
  shotIndex,
}: ShotStageProps) {
  const addImage = (
    <BlockedReason reason={addition.blocker} side="bottom">
      <IconButton
        aria-disabled={addition.blocker === undefined ? undefined : true}
        className={workbenchControl({ shape: 'icon' })}
        label="添加图片"
        name="add"
        onClick={() => {
          if (addition.blocker === undefined) addition.onAdd()
        }}
        size="sm"
        title={addition.blocker === undefined ? '添加图片' : undefined}
      />
    </BlockedReason>
  )
  return (
    <div className="storyboard-stage" {...addition.drop.dragHandlers}>
      <div
        className="storyboard-hero"
        style={{ '--storyboard-ar': aspectValueOf(aspectRatio) } as CSSProperties}
      >
        {frame === undefined ? (
          <div className="storyboard-media">
            <p className="text-body-sm text-on-surface-faint">这段还没有图</p>
            <div className="storyboard-frame-tools">{addImage}</div>
          </div>
        ) : (
          <FramePreview
            badge={frame.badge}
            disabled={disabled}
            key={`${frame.number}:${frame.url}`}
            name={`镜头组 ${shotIndex} 第 ${frame.number} 帧`}
            number={frame.number}
            onEdit={() => onEditFrame(frame.number, { kind: 'draft' })}
            onOpen={() => onOpenFrame(frame)}
            onOpenResult={(jobId) => onEditFrame(frame.number, { kind: 'result', jobId })}
            onReplace={(url) => onReplaceFrame(frame.number, frame.url, url)}
            onUpload={(file) => uploadMediaFile(file, 'image')}
            onUploadingChange={onReplacingChange}
            tools={addImage}
            url={frame.url}
          />
        )}
        <IconButton
          className={cn(
            workbenchControl({ shape: 'icon' }),
            'storyboard-hero-nav storyboard-hero-prev',
          )}
          disabled={onPrevious === undefined}
          label="上一帧"
          name="back"
          onClick={onPrevious}
          size="sm"
        />
        <IconButton
          className={cn(
            workbenchControl({ shape: 'icon' }),
            'storyboard-hero-nav storyboard-hero-next',
          )}
          disabled={onNext === undefined}
          label="下一帧"
          name="next"
          onClick={onNext}
          size="sm"
        />
        <div className="storyboard-hero-foot">
          <StageUploadStatus onRetry={addition.onRetry} upload={addition.upload} />
          {gallery.urls.length === 0 ? null : (
            <span className="ml-auto">
              <FrameCounter
                add={{ blocker: addition.blocker, onAdd: addition.onAdd }}
                aspectRatio={aspectRatio}
                gallery={gallery}
              />
            </span>
          )}
        </div>
      </div>
      {addition.drop.dragOver ? (
        <div aria-hidden className="storyboard-drop">
          <span className="storyboard-drop-hint">
            <Icon decorative name="image" size="md" />
            松开添加
          </span>
        </div>
      ) : null}
    </div>
  )
}
