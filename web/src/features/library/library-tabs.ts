export const LIBRARY_TABS = [
  { label: '成片', value: 'videos' },
  { label: '整片', value: 'whole-films' },
  { label: '参考视频', value: 'references' },
  { label: '品牌模板', value: 'brand-templates' },
] as const

export type LibraryTab = (typeof LIBRARY_TABS)[number]['value']

export const DEFAULT_LIBRARY_TAB: LibraryTab = 'videos'

export const LIBRARY_TAB_VALUES = LIBRARY_TABS.map((tab) => tab.value)
