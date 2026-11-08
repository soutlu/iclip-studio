import type { SubtitleSentence } from '@/shared/api/generated/types.gen'

export type { SubtitleSentence }

export type SourceSubtitle = { subtitleJobId: string; sentences: SubtitleSentence[] }

export type SourceMedia = {
  durationMs: number
  width: number
  height: number
  subtitle: SourceSubtitle | null
}

export type MusicBeat = { timeMs: number; strength: number }

export type MusicMedia = { durationMs: number; beats: MusicBeat[] }

export type EditContext = {
  sources: Record<string, SourceMedia>
  music: Record<string, MusicMedia>
  components: Record<string, number>
}
