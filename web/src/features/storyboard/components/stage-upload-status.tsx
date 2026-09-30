/** 舞台左下的新图上传状态：上传中是进度环加百分比；失败换成错误图标加重试，悬停或聚焦看原因。 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { FrameUpload } from '../use-frame-additions'
import { workbenchControl } from './workbench-control'

type StageUploadStatusProps = {
  upload: FrameUpload
  /** 用失败时留下的原文件再传一次。 */
  onRetry: () => void
}

export function StageUploadStatus({ onRetry, upload }: StageUploadStatusProps) {
  if (upload.kind === 'idle') return null
  if (upload.kind === 'uploading')
    return (
      <span
        aria-label={`上传中 ${upload.progress}%`}
        className="storyboard-upload-chip"
        role="status"
      >
        <ProgressRing value={upload.progress} />
        {upload.progress}%
      </span>
    )
  return (
    <span role="alert">
      <TooltipRoot>
        <TooltipTrigger asChild>
          <button
            aria-label="上传失败，点击重试"
            className={cn(workbenchControl({ shape: 'label', size: 'sm' }), 'text-error')}
            onClick={onRetry}
            type="button"
          >
            <Icon decorative name="alert" size="xs" />
            <Icon decorative name="refresh" size="xs" />
          </button>
        </TooltipTrigger>
        <TooltipContent align="start" side="top">
          {upload.message}
        </TooltipContent>
      </TooltipRoot>
    </span>
  )
}

/** 0–100 的进度环；底环淡、进度段实，从 12 点方向顺时针走。 */
function ProgressRing({ value }: { value: number }) {
  return (
    <svg aria-hidden className="size-4.5" fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" opacity={0.25} r="9" stroke="currentColor" strokeWidth={2.5} />
      <circle
        cx="12"
        cy="12"
        pathLength={100}
        r="9"
        stroke="currentColor"
        strokeDasharray={`${value} 100`}
        strokeLinecap="round"
        strokeWidth={2.5}
        transform="rotate(-90 12 12)"
      />
    </svg>
  )
}
