import type { SubtitleSentence } from '@/shared/api/generated/types.gen'

// 编辑操作读取、但不写进草稿的素材事实。时间都是整数毫秒，素材时间从该文件的 0 起算。

export type { SubtitleSentence }

export type SourceSubtitle = { subtitleJobId: string; sentences: SubtitleSentence[] }

export type SourceMedia = {
  durationMs: number
  width: number
  height: number
  /** 这条素材片的字幕记录；还没有识别结果时为 null，此时不知道口播在哪 */
  subtitle: SourceSubtitle | null
}

/** 音乐文件里的拍点；strength 是拍点分析给出的强度（0–1），只用于显示 */
export type MusicBeat = { timeMs: number; strength: number }

export type MusicMedia = { durationMs: number; beats: MusicBeat[] }

export type EditContext = {
  /** 按素材片的 sourceJobId */
  sources: Record<string, SourceMedia>
  /** 按音频记录的 jobId */
  music: Record<string, MusicMedia>
}
