import { durationMsOf, type CatalogItem } from './component-catalog'
import { setCaptionStyle } from './editing/captions'
import type { EditContext } from './editing/context'
import type { WholeFilmDraft } from './editing/draft'
import { addEndCard, replaceEndCardComponent } from './editing/end-cards'
import { addOverlay } from './editing/overlays'
import { refuse, type EditResult } from './editing/result'
import { cutsOf, endCard } from './editing/timeline'
import { setTransition } from './editing/transitions'

/** 成片区的四条轨 */
export type TrackLane = 'film' | 'overlay' | 'caption' | 'music'

/**
 * 组件怎么到成片里：点组件栏里的卡片，或拖到某条轨的某个时刻松手。
 * 点卡片放转场时用 `cutAfterClipId`：选中的那一段后面的切点（选中最后一段时被拒），或选中的那个转场所在的切点；
 * 什么都没选时为 undefined，放到离播放头最近的切点。
 */
export type Placing =
  | { via: 'click'; playheadMs: number; cutAfterClipId: string | undefined }
  | { via: 'drop'; lane: TrackLane; timeMs: number }

/** 每种组件该拖到哪条轨 */
const LANE_OF: Record<CatalogItem['placement'], TrackLane> = {
  intro: 'film',
  outro: 'film',
  transition: 'film',
  overlay: 'overlay',
  caption: 'caption',
}

const nearestCut = (draft: WholeFilmDraft, timeMs: number) =>
  cutsOf(draft).reduce<ReturnType<typeof cutsOf>[number] | undefined>(
    (best, cut) =>
      best === undefined || Math.abs(cut.timeMs - timeMs) < Math.abs(best.timeMs - timeMs)
        ? cut
        : best,
    undefined,
  )

/**
 * 把组件目录里的一个组件放进成片，一步编辑：
 * - 片头片尾放到它自己的那一端（片头组件只能当片头）；那一端已有就换组件，时长不变；
 * - 转场放到切点上：拖放时取离松手处最近的切点；点卡片时取 `cutAfterClipId`，没选时取离播放头最近的切点；
 * - 包装从播放头（或松手处）开始，取组件自带时长，放不下截短到所在空当；
 * - 字幕组件换掉字幕样式。
 * 可填项都不写进草稿，合成时取组件自己的默认值。
 */
export const placeComponent = (
  draft: WholeFilmDraft,
  item: CatalogItem,
  placing: Placing,
  { context }: { context: EditContext },
): EditResult => {
  if (placing.via === 'drop' && placing.lane !== LANE_OF[item.placement])
    return refuse('drop-elsewhere')
  switch (item.placement) {
    case 'intro':
    case 'outro': {
      const role = item.placement
      return endCard(draft, role)
        ? replaceEndCardComponent(draft, { role, component: item.name, variables: {} })
        : addEndCard(draft, {
            role,
            component: item.name,
            variables: {},
            durationMs: durationMsOf(item),
          })
    }
    case 'transition': {
      if (cutsOf(draft).length === 0) return refuse('no-cut')
      const afterClipId =
        placing.via === 'drop'
          ? nearestCut(draft, placing.timeMs)?.afterClipId
          : (placing.cutAfterClipId ?? nearestCut(draft, placing.playheadMs)?.afterClipId)
      if (afterClipId === undefined) return refuse('no-cut')
      return setTransition(draft, { afterClipId, component: item.name, variables: {} }, context)
    }
    case 'overlay':
      return addOverlay(draft, {
        component: item.name,
        durationMs: durationMsOf(item),
        variables: {},
        atMs: placing.via === 'drop' ? placing.timeMs : placing.playheadMs,
      })
    case 'caption':
      return setCaptionStyle(draft, { component: item.name })
  }
}
