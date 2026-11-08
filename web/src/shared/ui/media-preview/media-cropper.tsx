import type { SyntheticEvent } from 'react'
import ReactCrop, { type PercentCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import { cn } from '@/shared/lib/utils'

export type MediaPreviewCrop = {
  aspect: number
  value: PercentCrop
  onChange: (crop: PercentCrop) => void
}

type MediaCropperProps = {
  crop: MediaPreviewCrop
  alt: string
  src: string
  className: string
  onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void
  onDragStart: () => void
  onDragEnd: () => void
}

const axisOf = (crop: PercentCrop) => (crop.width < crop.height ? 'x' : 'y')

export function MediaCropper({
  alt,
  className,
  crop,
  onDragEnd,
  onDragStart,
  onImageLoad,
  src,
}: MediaCropperProps) {
  return (
    <ReactCrop
      ariaLabels={{ ...ReactCrop.defaultProps.ariaLabels, cropArea: '拖动选择保留的部分' }}
      aspect={crop.aspect}
      className={cn('media-cropper', `media-cropper-${axisOf(crop.value)}`, className)}
      crop={crop.value}
      keepSelection
      locked
      onChange={(_pixel, percent) => crop.onChange(percent)}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <img alt={alt} onLoad={onImageLoad} src={src} />
    </ReactCrop>
  )
}
