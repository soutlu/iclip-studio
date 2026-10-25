/**
 * 组件栏卡片悬停预览的合成页：只放这一个组件，按横版画布合成，正好铺满 16:9 的卡片，与成片的画幅无关。
 */

import { durationMsOf, type CatalogItem, type ComponentCatalog } from './component-catalog'
import { emptyDraft, type WholeFilmDraft } from './editing/draft'
import { previewState, type PreviewState } from './preview-document'

export const HOVER_CANVAS = { width: 1920, height: 1080 }

/** 只含这一个组件的预览页；组件没有时长（字幕样式）时不做预览，为 undefined */
export const hoverPreviewOf = (
  item: CatalogItem,
  catalog: ComponentCatalog,
  origin: string,
): PreviewState | undefined => {
  if (item.duration === null) return undefined
  const draft: WholeFilmDraft = {
    ...emptyDraft(),
    canvas: HOVER_CANVAS,
    layer0: [
      {
        id: 'hover',
        type: 'component',
        start: 0,
        duration: durationMsOf(item),
        playbackStart: 0,
        component: item.name,
        variables: {},
      },
    ],
  }
  return previewState(draft, { videos: {}, music: null, subtitles: {} }, catalog, origin)
}
