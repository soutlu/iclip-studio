/** 整片编辑单测用的草稿与上下文：片段按给出的顺序首尾相接排好。 */

import type {
  EditContext,
  MusicBeat,
  SourceMedia,
  SubtitleSentence,
  TransitionSpec,
} from '@/features/storyboard/whole-film/editing/context'
import {
  DEFAULT_CAPTION_COMPONENT,
  type ComponentClip,
  type Layer0Clip,
  type VideoClip,
  type WholeFilmDraft,
} from '@/features/storyboard/whole-film/editing/draft'

export const video = (
  id: string,
  sourceJobId: string,
  playbackStart: number,
  duration: number,
): VideoClip => ({
  id,
  type: 'video',
  start: 0,
  duration,
  playbackStart,
  sourceJobId,
  volume: 1,
})

export const card = (
  id: string,
  role: ComponentClip['role'],
  duration: number,
  variables: ComponentClip['variables'] = {},
): ComponentClip => ({
  id,
  type: 'component',
  role,
  start: 0,
  duration,
  component: `${role}-card`,
  variables,
})

export const draftOf = (
  layer0: Layer0Clip[],
  rest: Partial<Omit<WholeFilmDraft, 'layer0'>> = {},
): WholeFilmDraft => {
  let at = 0
  return {
    canvas: layer0.some((clip) => clip.type === 'video') ? { width: 1080, height: 1920 } : null,
    transitions: [],
    captions: { component: DEFAULT_CAPTION_COMPONENT, edits: [] },
    music: null,
    overlays: [],
    ...rest,
    layer0: layer0.map((clip) => {
      const placed = { ...clip, start: at }
      at += clip.duration
      return placed
    }),
  }
}

export const source = (
  durationMs: number,
  sentences: SubtitleSentence[] | null = null,
  subtitleJobId = 'sub',
): SourceMedia => ({
  durationMs,
  width: 1080,
  height: 1920,
  subtitle: sentences ? { subtitleJobId, sentences } : null,
})

export const sentence = (startMs: number, endMs: number, text = '口播'): SubtitleSentence => ({
  startMs,
  endMs,
  speaker: null,
  text,
})

/** 测试用的转场：0.5 秒，切点在正中，切点前后各占 250 毫秒 */
export const FADE = { cutAt: 0.5, durationMs: 500 }

export const contextOf = (
  sources: Record<string, SourceMedia>,
  music: Record<string, { durationMs: number; beats?: MusicBeat[] }> = {},
  transitions: Record<string, TransitionSpec> = { fade: FADE },
): EditContext => ({
  sources,
  music: Object.fromEntries(
    Object.entries(music).map(([id, m]) => [
      id,
      { durationMs: m.durationMs, beats: m.beats ?? [] },
    ]),
  ),
  transitions,
})

/** 每段的 [开始, 结束)，便于断言首尾相接 */
export const spans = (draft: WholeFilmDraft) =>
  draft.layer0.map((clip) => [clip.id, clip.start, clip.start + clip.duration] as const)

export const expectOk = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(`编辑被拒：${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}
