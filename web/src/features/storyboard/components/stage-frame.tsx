/** 舞台显示分镜帧：当前帧按画幅 contain，点画面开原图；这帧正在替换时压一层「正在上传」。画面上不放别的按钮，帧的操作在操作行。 */

import type { CSSProperties } from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'

type StageFrameProps = {
  /** 分镜画幅，画面按它占位。 */
  aspectRatio: string
  /** 当前帧；这段没有帧时为 undefined，舞台留空。 */
  frame: { name: string; url: string } | undefined
  /** 这一帧正在替换。 */
  uploading: boolean
  onOpen: () => void
}

export function StageFrame({ aspectRatio, frame, onOpen, uploading }: StageFrameProps) {
  return (
    <div
      className="storyboard-hero"
      style={{ '--storyboard-ar': aspectValueOf(aspectRatio) } as CSSProperties}
    >
      {frame === undefined ? (
        <div className="storyboard-media">
          <p className="text-body-sm text-on-surface-faint">这段还没有图</p>
        </div>
      ) : (
        <div aria-label="当前帧图片" className="storyboard-media" role="group">
          <button
            aria-label="打开原图"
            className="absolute inset-0 cursor-zoom-in ui-focus"
            onClick={onOpen}
            type="button"
          >
            <img
              alt={frame.name}
              className="size-full object-contain"
              draggable={false}
              src={frame.url}
            />
          </button>
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
      )}
    </div>
  )
}
