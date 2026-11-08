import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { MediaFallback } from '@/shared/ui/media-fallback'

type CompareImage = { url: string; label: string }

type CompareSliderProps = {
  before: CompareImage
  after: CompareImage
}

const KEY_STEP = 5

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)))

export function CompareSlider({ before, after }: CompareSliderProps) {
  const [position, setPosition] = useState(50)
  const [broken, setBroken] = useState(false)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  if (broken) return <MediaFallback className="image-edit-compare-fallback" kind="image" />

  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0) return
    setPosition(clampPercent(((event.clientX - rect.left) / rect.width) * 100))
  }
  const step = (event: KeyboardEvent<HTMLSpanElement>) => {
    const delta =
      event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : null
    if (delta === null) return
    event.preventDefault()
    setPosition((value) => clampPercent(value + delta))
  }

  return (
    <div
      className="image-edit-compare"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
        follow(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) follow(event)
      }}
      ref={surfaceRef}
      style={{ '--image-edit-split': `${position}%` } as CSSProperties}
    >
      <img alt={before.label} draggable={false} onError={() => setBroken(true)} src={before.url} />
      <div className="image-edit-compare-after">
        <img alt={after.label} draggable={false} onError={() => setBroken(true)} src={after.url} />
      </div>
      <span aria-hidden="true" className="image-edit-compare-label" data-side="before">
        {before.label}
      </span>
      <span aria-hidden="true" className="image-edit-compare-label" data-side="after">
        {after.label}
      </span>
      <span aria-hidden="true" className="image-edit-compare-line" />
      <span
        aria-label="对比分割线"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={position}
        aria-valuetext={`左侧${before.label}占 ${position}%`}
        className="image-edit-compare-knob"
        onKeyDown={step}
        role="slider"
        tabIndex={0}
      >
        <Icon decorative name="compare" size="sm" />
      </span>
    </div>
  )
}
