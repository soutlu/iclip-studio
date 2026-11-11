import { vi } from 'vitest'

type FakeWindow = {
  closed: boolean
  close: () => void
  focus: () => void
  location: { href: string }
}

/** 把 `window.open` 换成记录用的假窗口：每次调用开一个，`location.href` 记着它被转去的地址。 */
export const stubWindowOpen = () => {
  const windows: FakeWindow[] = []
  const open = vi.spyOn(window, 'open').mockImplementation(() => {
    const popup: FakeWindow = {
      close: vi.fn(() => {
        popup.closed = true
      }),
      closed: false,
      focus: vi.fn(),
      location: { href: 'about:blank' },
    }
    windows.push(popup)
    return popup as unknown as Window
  })
  return { open, windows }
}
