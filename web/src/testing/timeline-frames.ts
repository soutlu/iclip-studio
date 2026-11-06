/** 时间线缩略图排着队加载；jsdom 不下载图片，要看全部格子的用例用这个把队列走完。 */

import { fireEvent } from '@testing-library/react'

/** 依次报告 `root` 里每张图加载完，直到队列里没有新图出现。观察器要先报过「在可视区」。 */
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
