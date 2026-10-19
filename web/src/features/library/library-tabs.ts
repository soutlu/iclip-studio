export const LIBRARY_TABS = [
  { label: '成片素材', value: 'videos' },
  { label: '灵感库', value: 'references' },
  { label: '成片', value: 'whole-films' },
] as const

export type LibraryTab = (typeof LIBRARY_TABS)[number]['value']

export const DEFAULT_LIBRARY_TAB: LibraryTab = 'videos'

export const LIBRARY_TAB_VALUES = LIBRARY_TABS.map((tab) => tab.value)
