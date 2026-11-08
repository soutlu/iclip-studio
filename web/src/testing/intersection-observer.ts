import { act } from '@testing-library/react'
import { vi } from 'vitest'

export const stubIntersectionObserver = ({ inRange = false } = {}) => {
  let current = inRange
  const live = new Set<FakeIntersectionObserver>()

  class FakeIntersectionObserver {
    readonly #callback: IntersectionObserverCallback
    #target: Element | null = null

    constructor(callback: IntersectionObserverCallback) {
      this.#callback = callback
    }

    observe(target: Element) {
      this.#target = target
      live.add(this)
      queueMicrotask(() => this.report())
    }

    disconnect() {
      live.delete(this)
    }

    report() {
      if (this.#target === null || !live.has(this)) return
      const entry = { isIntersecting: current, target: this.#target }
      this.#callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
  }

  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

  return {
    scroll: async (inRange: boolean) => {
      current = inRange
      await act(async () => {
        for (const observer of live) observer.report()
      })
    },
  }
}
