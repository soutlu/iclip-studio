/** 预览卡里的裁切框：react-image-crop 的固定比例框，只能拖动、不能缩放或重画；外观见 media-preview.css 的 `.media-cropper`。 */

import type { SyntheticEvent } from 'react'
import ReactCrop, { type PercentCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import { cn } from '@/shared/lib/utils'

/** 图片要裁时交给预览卡的东西：框的宽高比、当前框（按图片的百分比）与拖动后的回调。 */
export type MediaPreviewCrop = {
  aspect: number
  value: PercentCrop
  onChange: (crop: PercentCrop) => void
}

type MediaCropperProps = {
  crop: MediaPreviewCrop
  alt: string
  src: string
  /** 尺寸上限写在外层：库让图片的 max-height 继承外层，写在图片上会被库的样式盖掉。 */
  className: string
  onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void
  onDragStart: () => void
  onDragEnd: () => void
}

/** 框只沿图片多出来的方向移动，把手画在那个方向的两条边上。 */
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
      // 锁定后没有缩放把手，只有裁切框本身需要中文名。
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
