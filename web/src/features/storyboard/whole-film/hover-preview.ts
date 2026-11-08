import { durationMsOf, type CatalogItem, type ComponentCatalog } from './component-catalog'
import { emptyDraft, type WholeFilmDraft } from './editing/draft'
import { previewState, type PreviewState } from './preview-document'

export const HOVER_CANVAS = { width: 1920, height: 1080 }

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
