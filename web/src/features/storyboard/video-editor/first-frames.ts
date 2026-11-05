import { centerCrop, makeAspectCrop, type PercentCrop } from 'react-image-crop'
import { formatDimensions } from '@/shared/ui/media-preview'
import { MAX_FIRST_FRAMES } from '../edit-prompt'

export type Size = { width: number; height: number }

export type PixelRect = Size & { x: number; y: number }

type FrameRole = '首帧' | '尾帧' | '参考图'

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

const ratioName = (size: Size) => {
  const hit = RATIO_NAMES.find(
    ([width, height]) =>
      Math.abs(ratioOf(size) - width / height) / (width / height) < RATIO_NAME_TOLERANCE,
  )
  return hit === undefined ? formatDimensions(size.width, size.height) : `${hit[0]}:${hit[1]}`
}

const roleOf = (index: number, count: number): FrameRole =>
  count > MAX_FIRST_FRAMES ? '参考图' : index === 0 ? '首帧' : '尾帧'

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
