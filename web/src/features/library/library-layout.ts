import { aspectOf } from '@/shared/lib/aspect-ratio'
import type { LibraryVideo } from './library.api'

export const columnCountFor = (width: number): number => {
  if (width >= 1380) return 5
  if (width >= 1060) return 4
  if (width >= 700) return 3
  return 2
}

export const columnGapFor = (width: number): number => (width < 700 ? 10 : 16)

const CARD_BODY_HEIGHT = 68

export const cardHeightFor = (video: LibraryVideo, columnWidth: number): number => {
  const { w, h } = aspectOf(video.take.aspectRatio)
  return (columnWidth * h) / w + CARD_BODY_HEIGHT
}

export const PLACEHOLDER_VIDEO_RATIO = 9 / 16

export const placeholderCardHeightFor = (columnWidth: number): number =>
  columnWidth / PLACEHOLDER_VIDEO_RATIO + CARD_BODY_HEIGHT

const SNAPSHOT_WIDTHS = [240, 360, 480, 640, 720] as const

export const snapshotWidthFor = (cssWidth: number, pixelRatio: number): number => {
  const wanted = cssWidth * Math.min(pixelRatio, 2)
  return SNAPSHOT_WIDTHS.find((width) => width >= wanted) ?? SNAPSHOT_WIDTHS.at(-1) ?? 720
}
