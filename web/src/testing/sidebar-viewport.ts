import { vi } from 'vitest'

/**
 * jsdom 不排版；为侧栏的数据与交互测试提供足够容纳 50 行的视口。
 * 只补滚动容器的浏览器几何，不替换虚拟列表；实际滚动与小视口行为由浏览器测试覆盖。
 */
export function stubSidebarViewport() {
  for (const [property, size] of [
    ['offsetHeight', 3000],
    ['offsetWidth', 248],
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)?.get
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('overflow-y-auto')) return size
      const measured: unknown = original?.call(this)
      return typeof measured === 'number' ? measured : 0
    })
  }
}
