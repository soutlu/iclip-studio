import { aspectOf } from '@/shared/lib/aspect-ratio'

/** 按画幅描的小方框，长边 `longSide` 像素；认不出的画幅按 9:16 描（见 `aspectOf`）。 */
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
