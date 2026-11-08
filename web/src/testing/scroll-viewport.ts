import { vi } from 'vitest'

type Viewport = { role: string; name: string }

const isViewport = (element: HTMLElement, { role, name }: Viewport): boolean =>
  element.getAttribute('aria-label') === name &&
  (element.getAttribute('role') ?? element.tagName.toLowerCase()) === role

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

export const stubSidebarViewport = () =>
  stubScrollViewport({ role: 'region', name: '任务列表' }, { width: 248, height: 3000 })
