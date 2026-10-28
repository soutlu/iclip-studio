/** 图生时每张图的用途与裁切。网关按张数把图当首帧、尾帧或参考图（见 MAX_FIRST_FRAMES）；首帧定出片画幅，
 * 首帧、尾帧与原片画幅相差超过 1% 的要裁成原片画幅，参考图不裁。 */

import { centerCrop, makeAspectCrop, type PercentCrop } from 'react-image-crop'
import { formatDimensions } from '@/shared/ui/media-preview'
import { MAX_FIRST_FRAMES } from '../edit-prompt'

export type Size = { width: number; height: number }

/** 原图上的像素框。 */
export type PixelRect = Size & { x: number; y: number }

type FrameRole = '首帧' | '尾帧' | '参考图'

/** 一张图在图生里怎么用：用途；要裁时的框（`value` 按图片的百分比，没拖过就是居中最大的框；`rect` 是它在
 * 原图上的像素框）；预览卡第二行的说明。 */
type FramePlan = {
  role: FrameRole
  crop: { value: PercentCrop; rect: PixelRect } | undefined
  details: string
}

const SAME_RATIO_TOLERANCE = 0.01
const RATIO_NAME_TOLERANCE = 0.02
const RATIO_NAMES: readonly (readonly [number, number])[] = [
  [1, 1],
  [3, 4],
  [4, 3],
  [9, 16],
  [16, 9],
  [2, 3],
  [3, 2],
  [4, 5],
  [5, 4],
  [21, 9],
]

const ratioOf = ({ width, height }: Size) => width / height

const sameRatio = (image: Size, video: Size) =>
  Math.abs(ratioOf(image) - ratioOf(video)) / ratioOf(video) <= SAME_RATIO_TOLERANCE

/** 常见比例写成「3:4」，认不出的写像素尺寸。 */
const ratioName = (size: Size) => {
  const hit = RATIO_NAMES.find(
    ([width, height]) =>
      Math.abs(ratioOf(size) - width / height) / (width / height) < RATIO_NAME_TOLERANCE,
  )
  return hit === undefined ? formatDimensions(size.width, size.height) : `${hit[0]}:${hit[1]}`
}

/** 去重后真正发送的 `count` 张图里第 `index` 张是什么：1 张首帧，2 张首帧、尾帧，更多都是参考图。 */
const roleOf = (index: number, count: number): FrameRole =>
  count > MAX_FIRST_FRAMES ? '参考图' : index === 0 ? '首帧' : '尾帧'

/** 图里按 `aspect` 能取的最大的居中框。 */
const defaultCrop = (image: Size, aspect: number): PercentCrop =>
  centerCrop(
    makeAspectCrop(
      ratioOf(image) > aspect ? { unit: '%', height: 100 } : { unit: '%', width: 100 },
      aspect,
      image.width,
      image.height,
    ),
    image.width,
    image.height,
  )

/** 百分比框换成原图上的像素框，取整后不越出原图。 */
const pixelRectOf = (crop: PercentCrop, image: Size): PixelRect => {
  const x = Math.round((crop.x / 100) * image.width)
  const y = Math.round((crop.y / 100) * image.height)
  return {
    x,
    y,
    width: Math.min(Math.round((crop.width / 100) * image.width), image.width - x),
    height: Math.min(Math.round((crop.height / 100) * image.height), image.height - y),
  }
}

const planFrame = (
  role: FrameRole,
  image: Size | undefined,
  video: Size | undefined,
  chosen: PercentCrop | undefined,
): FramePlan => {
  if (image === undefined) return { role, crop: undefined, details: role }
  if (role === '参考图' || video === undefined || sameRatio(image, video))
    return {
      role,
      crop: undefined,
      details: `${role} · ${formatDimensions(image.width, image.height)}`,
    }
  const value = chosen ?? defaultCrop(image, ratioOf(video))
  const rect = pixelRectOf(value, image)
  const small = rect.width < video.width || rect.height < video.height
  return {
    role,
    crop: { value, rect },
    details: `${role} · 已裁成 ${ratioName(video)}${small ? ' · 图片偏小' : ''}`,
  }
}

/** `urls` 是去重后真正发送的图；`sizeOf` 给读到的原图尺寸，`video` 是原片尺寸，都可能还没读到；
 * `crops` 是用户拖过的框。返回按地址查的每张图的用途与裁切。 */
export const planFrames = ({
  urls,
  sizeOf,
  video,
  crops,
}: {
  urls: readonly string[]
  sizeOf: (url: string) => Size | undefined
  video: Size | undefined
  crops: ReadonlyMap<string, PercentCrop>
}): Map<string, FramePlan> =>
  new Map(
    urls.map((url, index) => [
      url,
      planFrame(roleOf(index, urls.length), sizeOf(url), video, crops.get(url)),
    ]),
  )
