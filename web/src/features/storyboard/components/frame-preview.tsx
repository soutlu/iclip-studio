/** 舞台上的当前帧：以帧号和地址为 key 挂载，切换图片即丢弃旧上传。替换只走「替换图片」按钮；拖入的图由舞台当作新增。 */

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { StatusBadge } from '@/shared/ui/status-badge'
import { toast } from '@/shared/ui/toast'
import { frameBadgeStatus, frameBadgeText, type FrameBadge } from '../frame-status'
import { workbenchControl } from './workbench-control'

type FramePreviewProps = {
  disabled: boolean
  /** 帧号，画面左上角标成「@N」。 */
  number: number
  /** 这一帧最新图片任务的状态；没有任务或已经看过就不给。 */
  badge?: FrameBadge | undefined
  name: string
  url: string
  onOpen: () => void
  onEdit?: (() => void) | undefined
  /** 点角标看这条新结果；与 `onEdit` 同一个编辑器，只是打开时选中的图不同。 */
  onOpenResult?: ((jobId: string) => void) | undefined
  onUpload: (file: File) => Promise<string>
  onReplace: (url: string) => void
  onUploadingChange: (uploading: boolean) => void
  /** 挂进画面右上工具组末尾的额外按钮（如添加图片）。 */
  tools?: ReactNode
}

export function FramePreview({
  badge,
  disabled,
  name,
  number,
  onOpen,
  onEdit,
  onOpenResult,
  onReplace,
  onUploadingChange,
  onUpload,
  tools,
  url,
}: FramePreviewProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const uploadRef = useRef({ active: true, busy: false })
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    const upload = uploadRef.current
    upload.active = true
    return () => {
      upload.active = false
    }
  }, [])

  const replace = async (file: File) => {
    const upload = uploadRef.current
    if (disabled || upload.busy) return
    upload.busy = true
    setUploading(true)
    try {
      const nextUrl = await onUpload(file)
      if (upload.active) onReplace(nextUrl)
    } catch (error) {
      // 切走之后结果可以不要，失败必须让人知道。
      toast.error(errorMessageOf(error, '上传失败'))
    } finally {
      upload.busy = false
      if (upload.active) setUploading(false)
    }
  }

  const reportUploading = useEffectEvent(onUploadingChange)
  useEffect(() => {
    reportUploading(uploading)
    return () => reportUploading(false)
  }, [uploading])

  const toolClass = workbenchControl({ shape: 'icon' })
  return (
    <div aria-label="当前帧图片" className="storyboard-media relative min-h-0 min-w-0" role="group">
      <button
        aria-label="打开原图"
        className="absolute inset-0 cursor-zoom-in ui-focus"
        onClick={onOpen}
        type="button"
      >
        <img alt={name} className="size-full object-contain" draggable={false} src={url} />
      </button>
      <div className="storyboard-frame-marks">
        <span className="storyboard-tag">@{number}</span>
        {badge === undefined ? null : badge.kind === 'result' && onOpenResult !== undefined ? (
          <button
            className="flex cursor-pointer rounded-full ui-focus disabled:cursor-default"
            disabled={disabled || uploading}
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
        ) : (
          <p
            className="pointer-events-none flex items-center gap-1.5"
            role={badge.kind === 'failed' ? 'alert' : 'status'}
          >
            <StatusBadge
              appearance="label"
              kind="image"
              status={frameBadgeStatus(badge)}
              text={frameBadgeText(badge)}
            />
            {badge.kind === 'failed' && badge.message !== null ? (
              <span className="rounded-full bg-surface-container-lowest px-2 py-1 text-caption text-on-surface">
                {badge.message}
              </span>
            ) : null}
          </p>
        )}
      </div>
      <div className="storyboard-frame-tools">
        {onEdit === undefined ? null : (
          <IconButton
            className={toolClass}
            data-frame-edit=""
            disabled={disabled || uploading}
            label="编辑图片"
            name="edit-image"
            onClick={onEdit}
            size="sm"
            title="编辑图片"
          />
        )}
        <IconButton
          className={toolClass}
          disabled={disabled || uploading}
          label="替换图片"
          name="image"
          onClick={() => inputRef.current?.click()}
          size="sm"
          title="替换图片"
        />
        <input
          accept={MEDIA_IMAGE_ACCEPT}
          aria-label="选择替换图片"
          className="hidden"
          disabled={disabled || uploading}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) void replace(file)
          }}
          ref={inputRef}
          type="file"
        />
        {tools}
      </div>
      {uploading ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-scrim/32 text-body-sm text-on-scrim"
          role="status"
        >
          <Icon className="animate-spin" decorative name="loading" size="md" />
          正在上传…
        </div>
      ) : null}
    </div>
  )
}
