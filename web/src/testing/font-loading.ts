/** jsdom 没有 FontFace 与 document.fonts；字体预览的测试用这个可控替身。 */

import { vi } from 'vitest'

type LoadMode = 'immediate' | 'deferred' | { error: Error }

/** FontFace 经 `vi.stubGlobal` 替换，用例结束要 `vi.unstubAllGlobals()`，再调用返回的 `restore()` 还原 document.fonts。 */
export const stubFontLoading = (mode: LoadMode = 'immediate') => {
  let current = mode
  const installed = new Set<FontFace>()
  const created: { family: string; source: string }[] = []
  const pending: (() => void)[] = []
  const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', { configurable: true, value: installed })

  vi.stubGlobal(
    'FontFace',
    class {
      constructor(family: string, source: string) {
        created.push({ family, source })
      }

      load() {
        if (current === 'immediate') return Promise.resolve(this)
        if (current === 'deferred')
          return new Promise((resolve) => pending.push(() => resolve(this)))
        return Promise.reject(current.error)
      }
    },
  )

  return {
    installed: installed as ReadonlySet<FontFace>,
    created: created as readonly { family: string; source: string }[],
    pendingCount: () => pending.length,
    setMode: (next: LoadMode) => {
      current = next
    },
    finish: () => {
      for (const resolve of pending.splice(0)) resolve()
    },
    restore: () => {
      if (descriptor === undefined) Reflect.deleteProperty(document, 'fonts')
      else Object.defineProperty(document, 'fonts', descriptor)
    },
  }
}
