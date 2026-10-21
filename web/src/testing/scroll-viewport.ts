import { vi } from 'vitest'

/** 按角色与可访问名认出的滚动容器；`role` 为 `main` 时也认不带 role 属性的 `<main>`。 */
type Viewport = { role: string; name: string }

const isViewport = (element: HTMLElement, { role, name }: Viewport): boolean =>
  element.getAttribute('aria-label') === name &&
  (element.getAttribute('role') ?? element.tagName.toLowerCase()) === role

/**
 * jsdom 不排版，元素尺寸都是 0：给指定的滚动容器一个视口大小，虚拟列表才会渲染视口里的内容。
 * 只改这个容器的 offsetWidth / offsetHeight，其余元素照旧。
 */
export function stubScrollViewport(viewport: Viewport, size: { width: number; height: number }) {
  for (const [property, length] of [
    ['offsetHeight', size.height],
    ['offsetWidth', size.width],
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)?.get
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (isViewport(this, viewport)) return length
      const measured: unknown = original?.call(this)
      return typeof measured === 'number' ? measured : 0
    })
  }
}

/** 侧栏「任务列表」滚动区，高度够放下 50 行以上。 */
export const stubSidebarViewport = () =>
  stubScrollViewport({ role: 'region', name: '任务列表' }, { width: 248, height: 3000 })
