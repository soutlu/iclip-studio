/** jsdom 没有 IntersectionObserver；滚到底自动翻页的组件测试用这个可控替身，由用例把被观察的元素滚进、滚出范围。 */

import { act } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * 用 `vi.stubGlobal` 换上替身，用例结束要 `vi.unstubAllGlobals()`。和真的一样，开始观察时报一次当前状态，之后范围变了再报；
 * 所有被观察的元素共用一个「在不在范围内」，`inRange` 是挂载时的初值。
 */
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
    /** 把被观察的元素滚进（true）或滚出（false）范围，正在观察的替身各报一次。 */
    scroll: async (inRange: boolean) => {
      current = inRange
      await act(async () => {
        for (const observer of live) observer.report()
      })
    },
  }
}
