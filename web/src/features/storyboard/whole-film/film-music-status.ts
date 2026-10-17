import type { AudioPeaks } from '../editing/audio-peaks'
import type { GainPoint, MusicPlacement, Song } from './film-music'

export type MusicPlan = {
  audioJobId: string
  start: number
  curve: readonly GainPoint[]
  volume?: number | undefined
}

export type ReadyMusic = {
  kind: 'ready'
  title: string
  song: Song
  peaks: AudioPeaks
  placement: MusicPlacement
  previewCurve: readonly GainPoint[]
  plan: MusicPlan
}

const PENDING = {
  uploading: { track: '正在上传音乐…', blocked: '音乐上传中，暂时无法合成' },
  submitting: { track: '正在提交音乐生成…', blocked: '音乐生成提交中，暂时无法合成' },
  generating: { track: '音乐生成中，完成后自动对齐', blocked: '音乐生成中，暂时无法合成' },
  reading: { track: '正在读取音乐…', blocked: '音乐读取中，暂时无法合成' },
} as const

type PendingMusic = { kind: keyof typeof PENDING }

export type MusicStatus =
  | { kind: 'none' }
  | PendingMusic
  | { kind: 'failed'; message: string; onRetry: (() => void) | undefined }
  | ReadyMusic

export const isMusicPending = (status: MusicStatus): status is PendingMusic =>
  status.kind in PENDING

export const musicTrackLabel = (status: MusicStatus): string | undefined => {
  if (isMusicPending(status)) return PENDING[status.kind].track
  if (status.kind === 'failed') return status.message
  return undefined
}

export const musicBlockedReason = (status: MusicStatus): string | undefined => {
  if (isMusicPending(status)) return PENDING[status.kind].blocked
  if (status.kind === 'failed') return '音乐不可用，无法合成；请重试、更换或删除音乐'
  if (status.kind === 'ready' && status.placement.shortBy > 0)
    return `音乐比成片短 ${status.placement.shortBy.toFixed(1)} 秒，无法合成；请重新生成或更换音乐`
  return undefined
}

export const composableMusic = (status: MusicStatus): MusicPlan | null =>
  status.kind === 'ready' && status.placement.shortBy === 0 ? status.plan : null
