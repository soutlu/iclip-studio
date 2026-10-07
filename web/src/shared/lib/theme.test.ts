import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'cue.appearance'

/** 可控的系统配色：`set` 改深浅并通知监听者。 */
const stubSystem = (dark: boolean) => {
  const listeners = new Set<() => void>()
  const media = {
    get matches() {
      return dark
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
  }
  vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList)
  return {
    set: (next: boolean) => {
      dark = next
      for (const listener of listeners) listener()
    },
  }
}

/** 每次拿一份新的模块：外观偏好是模块里的状态。 */
const loadTheme = async () => {
  vi.resetModules()
  return import('./theme')
}

const isDark = () => document.documentElement.classList.contains('dark')

describe('外观', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.classList.remove('dark')
    window.localStorage.clear()
  })

  it('默认跟随系统：系统换深浅，页面跟着换', async () => {
    const system = stubSystem(false)
    const { initTheme } = await loadTheme()

    initTheme()
    expect(isDark()).toBe(false)
    system.set(true)
    expect(isDark()).toBe(true)
  })

  it('选了深色或浅色就不看系统，选的记在浏览器里', async () => {
    const system = stubSystem(false)
    const { initTheme, setThemePreference } = await loadTheme()
    initTheme()

    setThemePreference('dark')
    expect(isDark()).toBe(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark')
    setThemePreference('light')
    system.set(true)
    expect(isDark()).toBe(false)
  })

  it('打开时读回上次选的；存的不认识就跟随系统', async () => {
    stubSystem(true)
    window.localStorage.setItem(STORAGE_KEY, 'light')
    ;(await loadTheme()).initTheme()
    expect(isDark()).toBe(false)

    window.localStorage.setItem(STORAGE_KEY, 'sepia')
    ;(await loadTheme()).initTheme()
    expect(isDark()).toBe(true)
  })

  it('浏览器不让存时照样换，只在这次打开期间有效', async () => {
    stubSystem(false)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const { initTheme, setThemePreference } = await loadTheme()

    initTheme()
    setThemePreference('dark')
    expect(isDark()).toBe(true)
  })
})
