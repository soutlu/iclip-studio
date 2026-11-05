import { useRef } from 'react'
import { MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { cn } from '@/shared/lib/utils'
import { StatusBadge } from '@/shared/ui/status-badge'
import { frameBadgeStatus, frameBadgeText, type FrameBadge } from '../frame-status'
import { StageAction } from './stage-action'
import { StageBar } from './stage-bar'

export type StageFrameInfo = {
  number: number
  url: string
  badge: FrameBadge | undefined
}

type FrameStageBarProps = {
  frame: StageFrameInfo | undefined
  disabled: boolean
  replacing: boolean
  onReplaceFile: (file: File) => void
  onEditFrame: (frame: number, open: { kind: 'draft' } | { kind: 'result'; jobId: string }) => void
}

export function FrameStageBar({
  disabled,
  frame,
  onEditFrame,
  onReplaceFile,
  replacing,
}: FrameStageBarProps) {
  const locked = disabled || replacing
  return (
    <StageBar
      end={
        frame === undefined ? null : (
          <FrameTools
            locked={locked}
            onEdit={() => onEditFrame(frame.number, { kind: 'draft' })}
            onReplaceFile={onReplaceFile}
          />
        )
      }
      start={
        <>
          {frame === undefined ? null : (
            <p className="storyboard-stage-glass storyboard-stage-tag">@{frame.number}</p>
          )}
          {frame?.badge === undefined ? null : (
            <FrameBadgeMark
              badge={frame.badge}
              disabled={locked}
              onOpenResult={(jobId) => onEditFrame(frame.number, { kind: 'result', jobId })}
            />
          )}
        </>
      }
    />
  )
}

function FrameTools({
  locked,
  onEdit,
  onReplaceFile,
}: {
  locked: boolean
  onEdit: () => void
  onReplaceFile: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <StageAction
        data-frame-edit=""
        disabled={locked}
        icon="edit-image"
        label="编辑图片"
        onClick={onEdit}
        text="编辑"
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
    </>
  )
}

export function FrameBadgeMark({
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
      className={cn(
        'flex max-w-full min-w-0 items-center gap-1.5',
        message !== null && 'storyboard-stage-glass storyboard-stage-note',
      )}
      role={badge.kind === 'failed' ? 'alert' : 'status'}
    >
      <StatusBadge
        appearance="label"
        kind="image"
        status={frameBadgeStatus(badge)}
        text={frameBadgeText(badge)}
      />
      {message === null ? null : (
        <span className="min-w-0 truncate" title={message}>
          {message}
        </span>
      )}
    </p>
  )
}
