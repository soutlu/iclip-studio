/** 舞台显示分镜帧时下方的操作行：左边 @N、图片任务角标与新图上传状态，右边编辑图片与替换。
 * 切帧箭头与帧计数叠在舞台上，不在这一行（见 `StageFrameNav`）。 */

import { useRef } from 'react'
import { MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { cn } from '@/shared/lib/utils'
import { StatusBadge } from '@/shared/ui/status-badge'
import { frameBadgeStatus, frameBadgeText, type FrameBadge } from '../frame-status'
import type { FrameUpload } from '../use-frame-additions'
import { StageAction } from './stage-action'
import { StageUploadStatus } from './stage-upload-status'

export type StageFrameInfo = {
  number: number
  url: string
  /** 这一帧最新图片任务的角标；没有或已看过就不给。 */
  badge: FrameBadge | undefined
}

type FrameActionRowProps = {
  /** 当前帧；这段没有帧时为 undefined，右边没有按钮。 */
  frame: StageFrameInfo | undefined
  disabled: boolean
  /** 往选中段添加新图（粘贴、选择器上传）的进度与失败重试。 */
  addition: { upload: FrameUpload; onRetry: () => void }
  /** 当前帧正在替换。 */
  replacing: boolean
  onReplaceFile: (file: File) => void
  /** 打开这一帧的编辑器；`open` 决定进去先看哪张：编辑按钮进底图，角标进那条新结果。 */
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
}

export function FrameActionRow({
  addition,
  disabled,
  frame,
  onEditFrame,
  onReplaceFile,
  replacing,
}: FrameActionRowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const locked = disabled || replacing
  return (
    <div className="storyboard-actions" data-kind="frame">
      <div className="storyboard-actions-start">
        {frame === undefined ? null : <span className="storyboard-tag">@{frame.number}</span>}
        {frame?.badge === undefined ? null : (
          <FrameBadgeMark
            badge={frame.badge}
            disabled={locked}
            onOpenResult={(jobId) => onEditFrame(frame.number, { kind: 'result', jobId })}
          />
        )}
        <StageUploadStatus onRetry={addition.onRetry} upload={addition.upload} />
      </div>
      {frame === undefined ? null : (
        <div className="storyboard-actions-end">
          <StageAction
            data-frame-edit=""
            disabled={locked}
            icon="edit-image"
            label="编辑图片"
            onClick={() => onEditFrame(frame.number, { kind: 'draft' })}
          />
          <StageAction
            disabled={locked}
            icon="image"
            label="替换图片"
            onClick={() => inputRef.current?.click()}
            text="替换"
          />
          <input
            accept={MEDIA_IMAGE_ACCEPT}
            aria-label="选择替换图片"
            className="hidden"
            disabled={locked}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) onReplaceFile(file)
            }}
            ref={inputRef}
            type="file"
          />
        </div>
      )}
    </div>
  )
}

/** 这一帧最新图片任务的角标：有新结果时是按钮，点了看那条结果；其余只是状态，失败带原话（放不下时截断，悬停看全）。 */
function FrameBadgeMark({
  badge,
  disabled,
  onOpenResult,
}: {
  badge: FrameBadge
  disabled: boolean
  onOpenResult: (jobId: string) => void
}) {
  if (badge.kind === 'result')
    return (
      <button
        className="flex shrink-0 cursor-pointer rounded-full ui-focus disabled:cursor-default"
        disabled={disabled}
        onClick={() => onOpenResult(badge.jobId)}
        type="button"
      >
        <StatusBadge
          appearance="label"
          kind="image"
          status={frameBadgeStatus(badge)}
          text="有新结果 · 查看"
        />
      </button>
    )
  const message = badge.kind === 'failed' ? badge.message : null
  return (
    <p
      className={cn('flex min-w-0 items-center gap-1.5', message !== null && 'flex-1')}
      role={badge.kind === 'failed' ? 'alert' : 'status'}
    >
      <StatusBadge
        appearance="label"
        kind="image"
        status={frameBadgeStatus(badge)}
        text={frameBadgeText(badge)}
      />
      {message === null ? null : (
        <span className="min-w-0 truncate text-caption text-on-surface-variant" title={message}>
          {message}
        </span>
      )}
    </p>
  )
}
