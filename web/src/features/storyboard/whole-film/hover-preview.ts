import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { writeFilm, type Canvas } from './composition/film'
import { previewDocument } from './preview-document'

/** 悬停预览的画布：和卡片上的封面一样是横版。 */
export const HOVER_CANVAS: Canvas = { width: 1920, height: 1080 }

/** 悬停预览用的那一份：只有这一个组件、从头播到它的时长；条目没写时长时是 undefined，不预览。 */
export const hoverPreviewOf = (
  item: CatalogItem,
  catalog: ComponentCatalog,
  origin: string,
): string | undefined => {
  if (item.duration === null) return undefined
  const clip = {
    kind: 'host' as const,
    id: 'hover',
    label: item.title,
    item: item.name,
    src: item.src,
    start: 0,
    duration: Math.round(item.duration * 1000),
    playbackStart: 0,
    track: 0,
    values: {},
    z: 0,
    hidden: false,
  }
  return previewDocument(
    writeFilm({ canvas: HOVER_CANVAS, clips: [clip] }, catalog),
    catalog,
    origin,
  )
}
