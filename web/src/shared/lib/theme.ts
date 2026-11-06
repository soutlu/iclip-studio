import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

const STORAGE_KEY = 'cue.appearance'

const read = (): ThemePreference => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return THEME_PREFERENCES.find((item) => item === stored) ?? 'system'
  } catch {
    return 'system'
  }
}

let preference: ThemePreference = 'system'
const listeners = new Set<() => void>()
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)')

const apply = () => {
  const dark = preference === 'dark' || (preference === 'system' && systemDark().matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function initTheme() {
  preference = read()
  apply()
  systemDark().addEventListener('change', apply)
}

export function setThemePreference(next: ThemePreference) {
  preference = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 忽略浏览器禁用或写满 Web Storage 时抛出的异常。
  }
  apply()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(subscribe, () => preference)
