import { aspectOf } from '@/shared/lib/aspect-ratio'

/** 小图长边的像素；短边按画幅算，竖版 9:16 正好 40×71。 */
const THUMB_LONG_SIDE = 71

/** 某个画幅下版本小图格（version-thumb）的像素尺寸：长边 71，短边按比例。版本条旁的画面也按它让出位置。 */
export const versionThumbSize = (ratio: string): { width: number; height: number } => {
  const { h, w } = aspectOf(ratio)
  const scale = THUMB_LONG_SIDE / Math.max(w, h)
  return { height: Math.round(h * scale), width: Math.round(w * scale) }
}
