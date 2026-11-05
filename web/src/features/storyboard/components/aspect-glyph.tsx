import { aspectOf } from '@/shared/lib/aspect-ratio'

export function AspectGlyph({ longSide, ratio }: { longSide: number; ratio: string }) {
  const { h, w } = aspectOf(ratio)
  const scale = longSide / Math.max(w, h)
  return (
    <span
      aria-hidden
      className="storyboard-bar-glyph"
      style={{ height: Math.round(h * scale), width: Math.round(w * scale) }}
    />
  )
}
