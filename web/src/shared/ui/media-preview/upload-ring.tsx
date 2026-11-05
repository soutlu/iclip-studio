import { Icon } from '@/shared/icons'

const RING_RADIUS = 6.5
const RING_LENGTH = 40.84

const SIZE_CLASS = { sm: 'size-(--icon-sm)', xs: 'size-(--icon-xs)' } as const

type UploadRingProps = {
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
