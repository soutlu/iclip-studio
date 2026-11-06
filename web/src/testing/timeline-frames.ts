import { fireEvent } from '@testing-library/react'

export const finishFrameLoads = (root: ParentNode = document) => {
  const loaded = new WeakSet<Element>()
  for (;;) {
    const pending = [...root.querySelectorAll('img')].filter((image) => !loaded.has(image))
    if (pending.length === 0) return
    for (const image of pending) {
      loaded.add(image)
      fireEvent.load(image)
    }
  }
}
