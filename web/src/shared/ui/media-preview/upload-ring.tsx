/** 上传进度环：预览卡第二行与输入框芯片共用；颜色取 currentColor，随所在文字走。 */

import { Icon } from '@/shared/icons'

/** 环的几何参考 Kimi mention-tip-media-ring。 */
const RING_RADIUS = 6.5
const RING_LENGTH = 40.84

/** 取图标刻度：预览卡跟 12px 文字走 xs，芯片缩略图格里用 sm。 */
const SIZE_CLASS = { sm: 'size-(--icon-sm)', xs: 'size-(--icon-xs)' } as const

type UploadRingProps = {
  /** 0–1；浏览器算不出总量时为 undefined，改为转圈。 */
  progress: number | undefined
  size: keyof typeof SIZE_CLASS
}

export function UploadRing({ progress, size }: UploadRingProps) {
  if (progress === undefined) {
    return <Icon className="shrink-0 animate-spin" decorative name="loading" size={size} />
  }
  return (
    <svg aria-hidden className={`shrink-0 ${SIZE_CLASS[size]}`} viewBox="0 0 16 16">
      <circle
        cx="8"
        cy="8"
        fill="none"
        r={RING_RADIUS}
        strokeWidth="1.5"
        style={{ stroke: 'color-mix(in srgb, currentColor 18%, transparent)' }}
      />
      <circle
        cx="8"
        cy="8"
        fill="none"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${(progress * RING_LENGTH).toFixed(1)} ${RING_LENGTH}`}
        strokeLinecap="round"
        strokeWidth="1.5"
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}
