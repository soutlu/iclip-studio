import type { IconName } from '@/shared/icons'
import type { ComponentCatalog } from './composition/catalog'
import { isDetachedAudio, isDubClip, type FilmClip } from './composition/film'
import { hostKindOf, ITEM_KIND_LABEL, type ItemKind } from './items'

/** 右栏的目录页签：镜头、元素、模板、配乐、字幕；`props` 是「属性」。 */
export type CatalogTab = 'shots' | ItemKind | 'audio' | 'captions'
export type SideTab = CatalogTab | 'props'

/** 目录页签在右栏导航里的顺序、短词和图标。 */
export const CATALOG_NAV: readonly { tab: CatalogTab; label: string; icon: IconName }[] = [
  { tab: 'shots', label: '镜头', icon: 'final-cut-shots' },
  { tab: 'component', label: ITEM_KIND_LABEL.component, icon: 'final-cut-overlays' },
  { tab: 'block', label: ITEM_KIND_LABEL.block, icon: 'final-cut-scenes' },
  { tab: 'audio', label: '配乐', icon: 'final-cut-music' },
  { tab: 'captions', label: '字幕', icon: 'final-cut-captions' },
]

export const CATALOG_TABS: readonly CatalogTab[] = CATALOG_NAV.map(({ tab }) => tab)

/**
 * 时间线上已经用上的目录页签（右栏导航上带圆点）：有字幕时是「字幕」；有配乐行上的那种音频（不是配音、
 * 也不是从视频分离出来的原声）时是「配乐」；有元素、模板片段时是对应的页签。「镜头」不算。
 */
export function usedTabs(
  clips: readonly FilmClip[],
  catalog: ComponentCatalog,
): ReadonlySet<CatalogTab> {
  const used = new Set<CatalogTab>()
  for (const clip of clips) {
    if (clip.kind === 'caption') used.add('captions')
    else if (clip.kind === 'audio' && !isDubClip(clip) && !isDetachedAudio(clip)) used.add('audio')
    else if (clip.kind === 'host') {
      const kind = hostKindOf(clip, catalog)
      if (kind !== undefined) used.add(kind)
    }
  }
  return used
}
