import { aspectOf } from '@/shared/lib/aspect-ratio'

const THUMB_LONG_SIDE = 71

export const versionThumbSize = (ratio: string): { width: number; height: number } => {
  const { h, w } = aspectOf(ratio)
  const scale = THUMB_LONG_SIDE / Math.max(w, h)
  return { height: Math.round(h * scale), width: Math.round(w * scale) }
}
