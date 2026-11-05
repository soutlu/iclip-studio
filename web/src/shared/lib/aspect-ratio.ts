import { zTaskVideoSpecInput } from '@/shared/api/generated/zod.gen'

export const ASPECT_RATIOS = zTaskVideoSpecInput.shape.aspect_ratio.unwrap().unwrap().options

const FALLBACK_ASPECT = { h: 16, w: 9 } as const

const RATIO = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/

export const aspectOf = (aspectRatio: string | null): { w: number; h: number } => {
  const match = aspectRatio === null ? null : RATIO.exec(aspectRatio)
  const w = Number(match?.[1])
  const h = Number(match?.[2])
  return w > 0 && h > 0 ? { h, w } : FALLBACK_ASPECT
}

export const aspectValueOf = (aspectRatio: string | null): number => {
  const { w, h } = aspectOf(aspectRatio)
  return w / h
}
