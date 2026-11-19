import type { IconName } from '@/shared/icons'
import { ITEM_KIND_LABEL, type ItemKind } from './items'

/** 右栏的目录页签：镜头、贴片、场景、配乐、字幕；`props` 是「属性」。 */
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
