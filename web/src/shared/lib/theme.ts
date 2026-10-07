/** 外观：跟随系统、浅色、深色，记在这台电脑的浏览器里。由 <html> 上的 .dark 统一切换。 */

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

/** 挂载前调用，避免首屏闪烁：读回存下的外观并应用；跟随系统时，系统配色一变就跟着变。 */
export function initTheme() {
  preference = read()
  apply()
  systemDark().addEventListener('change', apply)
}

/** 换外观：立即生效并记下。 */
export function setThemePreference(next: ThemePreference) {
  preference = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 浏览器禁用站点存储时，外观仍在这次打开期间生效。
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

/** 现在选的外观。 */
export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(subscribe, () => preference)
