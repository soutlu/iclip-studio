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

// 换上现在该显示的外观并通知订阅方；系统换深浅时也走这里，好让「现在是不是深色」跟着变
const apply = () => {
  const dark = preference === 'dark' || (preference === 'system' && systemDark().matches)
  document.documentElement.classList.toggle('dark', dark)
  for (const listener of listeners) listener()
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
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(subscribe, () => preference)

/** 页面现在显示的是不是深色：选了深色、浅色就是它，跟随系统时看系统。 */
export const useDarkTheme = (): boolean =>
  useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'))
