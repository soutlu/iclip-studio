import { createMediaReaderMock } from './media-reader'

// 存放 `mediabunny` 测试替身的模拟素材表。
// 独立拆出此文件且不依赖编辑器组件，以便各测试文件的 `vi.mock` 工厂动态加载时保持轻量，同时与 `final-cut-editor.tsx` 共享同一模块实例。

/** 各素材地址的关键帧（秒）和时长（秒）。 */
export const files = new Map<string, { keyframes: number[]; duration: number }>()
// 素材有没有音轨：在 `sounds` 里的有，在 `unreadable` 里的读音轨时出错，别的没有
export const sounds = new Set<string>()
export const unreadable = new Set<string>()

/** `vi.mock('mediabunny', ...)` 的工厂返回的替身：读上面登记的素材。 */
export const mediabunnyMock = () => {
  class AudioSampleSink {
    async *samples() {}
  }
  return {
    ...createMediaReaderMock(files, (url) =>
      unreadable.has(url)
        ? Promise.reject(new Error('读不出音轨'))
        : Promise.resolve(
            sounds.has(url)
              ? { canDecode: () => Promise.resolve(true), getNumberOfChannels: () => 1 }
              : null,
          ),
    ),
    AudioSampleSink,
  }
}
