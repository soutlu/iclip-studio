/** 成片编辑单测用的草稿与上下文：片段按给出的顺序首尾相接排好；测试组件库的组件目录。 */

import fixtureCatalogJson from '../../scripts/hyperframes-fixtures/catalog.json'
import type {
  CatalogItem,
  ComponentCatalog,
} from '@/features/storyboard/whole-film/composition/catalog'
import type {
  EditContext,
  MusicBeat,
  SourceMedia,
  SubtitleSentence,
} from '@/features/storyboard/whole-film/editing/context'
import {
  DEFAULT_CAPTION_COMPONENT,
  type ComponentClip,
  type Layer0Clip,
  type OverlayClip,
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

/** 画面轨上的一段组件 */
export const card = (
  id: string,
  duration: number,
  { component = 'card', playbackStart = 0, variables = {} }: Partial<ComponentClip> = {},
): ComponentClip => ({
  id,
  type: 'component',
  start: 0,
  duration,
  playbackStart,
  component,
  variables,
})

/**
 * 特效轨上的一块；默认在第 0 行、zIndex 为 1，画面上没挪过、原大、不转（同服务端发出的：位置、
 * 缩放、旋转与转轴总是写着）
 */
export const overlay = (
  id: string,
  start: number,
  duration: number,
  {
    component = 'badge',
    playbackStart = 0,
    track = 0,
    zIndex = 1,
    variables = {},
    x = 0,
    y = 0,
    scale = 1,
    rotation = 0,
    pivotX = 0,
    pivotY = 0,
  }: Partial<OverlayClip> = {},
): OverlayClip => ({
  id,
  component,
  start,
  duration,
  playbackStart,
  track,
  zIndex,
  variables,
  x,
  y,
  scale,
  rotation,
  pivotX,
  pivotY,
})

export const draftOf = (
  layer0: Layer0Clip[],
  rest: Partial<Omit<WholeFilmDraft, 'layer0'>> = {},
): WholeFilmDraft => {
  let at = 0
  return {
    canvas: layer0.some((clip) => clip.type === 'video') ? { width: 1080, height: 1920 } : null,
    // 同服务端发出的草稿：hidden、位置、缩放、旋转与转轴总是写着
    captions: {
      component: DEFAULT_CAPTION_COMPONENT,
      edits: [],
      hidden: false,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      pivotX: 0,
      pivotY: 0,
    },
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

/** components 是组件名 → 组件自己的时长（毫秒） */
export const contextOf = (
  sources: Record<string, SourceMedia>,
  music: Record<string, { durationMs: number; beats?: MusicBeat[] }> = {},
  components: Record<string, number> = {},
): EditContext => ({
  sources,
  music: Object.fromEntries(
    Object.entries(music).map(([id, m]) => [
      id,
      { durationMs: m.durationMs, beats: m.beats ?? [] },
    ]),
  ),
  components,
})

/** 每段的 [开始, 结束)，便于断言首尾相接 */
export const spans = (draft: WholeFilmDraft) =>
  draft.layer0.map((clip) => [clip.id, clip.start, clip.start + clip.duration] as const)

/**
 * 测试组件库（web/scripts/hyperframes-fixtures/）的组件目录，配一个固定的版本号；单测不依赖跑过组装工具。
 */
export const fixtureCatalog: ComponentCatalog = {
  ...(fixtureCatalogJson as Omit<ComponentCatalog, 'version'>),
  version: 'test-fixtures',
}

/** 测试组件目录里的一项；没有就报错 */
export const fixtureItem = (name: string): CatalogItem => {
  const item = fixtureCatalog.items.find((entry) => entry.name === name)
  if (item === undefined) throw new Error(`测试组件目录里没有 ${name}`)
  return item
}

export const expectOk = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(`编辑被拒：${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}
