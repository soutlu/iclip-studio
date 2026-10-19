/** 整片编辑单测用的草稿与上下文：片段按给出的顺序首尾相接排好。 */

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

/** 成片轨上的一段组件 */
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

/** 特效轨上的一块；默认在第 0 行、zIndex 为 1 */
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
  }: Partial<OverlayClip> = {},
): OverlayClip => ({ id, component, start, duration, playbackStart, track, zIndex, variables })

export const draftOf = (
  layer0: Layer0Clip[],
  rest: Partial<Omit<WholeFilmDraft, 'layer0'>> = {},
): WholeFilmDraft => {
  let at = 0
  return {
    canvas: layer0.some((clip) => clip.type === 'video') ? { width: 1080, height: 1920 } : null,
    // 同服务端发出的草稿：hidden 总是写着
    captions: { component: DEFAULT_CAPTION_COMPONENT, edits: [], hidden: false },
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

export const contextOf = (
  sources: Record<string, SourceMedia>,
  music: Record<string, { durationMs: number; beats?: MusicBeat[] }> = {},
): EditContext => ({
  sources,
  music: Object.fromEntries(
    Object.entries(music).map(([id, m]) => [
      id,
      { durationMs: m.durationMs, beats: m.beats ?? [] },
    ]),
  ),
})

/** 每段的 [开始, 结束)，便于断言首尾相接 */
export const spans = (draft: WholeFilmDraft) =>
  draft.layer0.map((clip) => [clip.id, clip.start, clip.start + clip.duration] as const)

/** 示例品牌组件：[品牌, 名字, 借用哪个真实组件的合成文件与缩略图] */
const BRAND_FIXTURES = [
  ['拾步', '拾步 片头', 'logo-sting'],
  ['拾步', '拾步 片尾', 'logo-outro'],
  ['暖屿', '暖屿 片头', 'logo-brand-close'],
  ['暖屿', '暖屿 片尾', 'logo-outro'],
] as const

/**
 * 真实目录里还没有品牌组件；在它后面补上两个品牌各两张示例卡（block、2 秒），
 * 借用真实组件的合成文件与缩略图，预览与放置照常可用。
 */
export const withBrandFixtures = (catalog: ComponentCatalog): ComponentCatalog => {
  const brandItem = ([brand, title, base]: (typeof BRAND_FIXTURES)[number], index: number) => {
    const source = catalog.items.find((item) => item.name === base)
    if (source === undefined) throw new Error(`目录里没有 ${base}`)
    const item: CatalogItem = {
      ...source,
      name: `brand-fixture-${index + 1}`,
      kind: 'block',
      title,
      description: `${brand}的品牌组件`,
      brand,
      duration: 2,
    }
    return item
  }
  return { ...catalog, items: [...catalog.items, ...BRAND_FIXTURES.map(brandItem)] }
}

export const expectOk = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(`编辑被拒：${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}
