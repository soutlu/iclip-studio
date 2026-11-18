import { createMediaReaderMock } from './media-reader'

// final-cut 编辑器用例里 `mediabunny` 的替身读的素材。各用例文件的 `vi.mock` 工厂经动态 import 取这个模块，
// 用例辅助（final-cut-editor.tsx）往里登记，同一个用例文件里两边拿到的是同一个模块实例。
// 单独成一个模块、只依赖 media-reader：替身的工厂只要这几个集合，不用跟着 final-cut-editor.tsx
// 把编辑器也加载进来

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
