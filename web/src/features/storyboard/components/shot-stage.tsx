/** 舞台：当前帧按画幅 contain 居中，画面上挂帧工具、上一帧/下一帧与上传状态。 */

import type { CSSProperties } from 'react'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { IconButton } from '@/shared/ui/button'
import type { FrameBadge } from '../frame-status'
import { FramePreview } from './frame-preview'

export type StageFrame = {
  number: number
  url: string
  /** 这一帧最新图片任务的角标；没有或已看过就不给。 */
  badge: FrameBadge | undefined
  /** 这一帧被几段共用时的说明。 */
  caption: string | undefined
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
  /** 给选中段添加图片；选中的不是正文（未引用的图）或正在上传时不给。 */
  onAddImage: (() => void) | undefined
  uploadingNewImage: boolean
  onOpenFrame: (frame: StageFrame) => void
  /** 打开这一帧的编辑器；`open` 决定进去先看哪张：铅笔进底图，角标进那条新结果。 */
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
  onReplaceFrame: (frame: number, previousUrl: string, url: string) => void
  onReplacingChange: (replacing: boolean) => void
}

/** 画幅字符串（宽:高）换成数字比例；读不出来时按方图摆。 */
const ratioOf = (aspectRatio: string): number => {
  const [width = 0, height = 0] = aspectRatio.split(':').map(Number)
  return width > 0 && height > 0 ? width / height : 1
}

export function ShotStage({
  aspectRatio,
  disabled,
  frame,
  onAddImage,
  onEditFrame,
  onNext,
  onOpenFrame,
  onPrevious,
  onReplaceFrame,
  onReplacingChange,
  shotIndex,
  uploadingNewImage,
}: ShotStageProps) {
  const addImage = (
    <IconButton
      disabled={disabled || onAddImage === undefined}
      label="添加图片"
      name="add"
      onClick={onAddImage}
      size="sm"
      title="添加图片"
    />
  )
  return (
    <div className="storyboard-stage">
      <div
        className="storyboard-hero"
        style={{ '--storyboard-ar': ratioOf(aspectRatio) } as CSSProperties}
      >
        {frame === undefined ? (
          <div className="storyboard-media">
            <p className="text-body-sm text-on-surface-faint">这段还没有图</p>
            <div className="storyboard-frame-tools">{addImage}</div>
          </div>
        ) : (
          <FramePreview
            aspectRatio={aspectRatio}
            badge={frame.badge}
            caption={frame.caption}
            disabled={disabled}
            key={`${frame.number}:${frame.url}`}
            name={`镜头组 ${shotIndex} 第 ${frame.number} 帧`}
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
          className="storyboard-hero-nav storyboard-hero-prev"
          disabled={onPrevious === undefined}
          label="上一帧"
          name="back"
          onClick={onPrevious}
          size="md"
        />
        <IconButton
          className="storyboard-hero-nav storyboard-hero-next"
          disabled={onNext === undefined}
          label="下一帧"
          name="next"
          onClick={onNext}
          size="md"
        />
        {uploadingNewImage ? (
          <span className="storyboard-upload-status" role="status">
            正在上传新图…
          </span>
        ) : null}
      </div>
    </div>
  )
}
