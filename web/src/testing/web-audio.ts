/** jsdom 没有 Web Audio：解码与出声的替身。解码出一段给定时长的声音；出声这边记下每次起播的位置与增益排程，
 * 供整片编辑器的预览混音测试断言。用 `vi.stubGlobal` 装上，`vi.unstubAllGlobals()` 卸下。 */

import { vi } from 'vitest'

/** 增益上的一次排程：定到某值，或线性走到某值。时刻是上下文时间（秒）。 */
export type GainEvent = { kind: 'set' | 'ramp'; value: number; time: number }

/** 一次起播：`start(when, offset, duration)` 的三个参数，以及它那条增益上的排程。 */
export type PlayedSource = {
  when: number
  offset: number
  duration: number | undefined
  gain: GainEvent[]
  stopped: boolean
}

export type WebAudioRecord = {
  played: PlayedSource[]
  /** 总音量（静音开关）上的排程。 */
  master: GainEvent[]
  /** 让上下文时钟走到某一刻，模拟播放了一段时间。 */
  advance: (seconds: number) => void
}

class FakeParam {
  readonly events: GainEvent[]
  constructor(events: GainEvent[] = []) {
    this.events = events
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'set', value, time })
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'ramp', value, time })
  }
}

class FakeNode {
  connect<T>(target: T): T {
    return target
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  readonly gain: FakeParam
  constructor(gain = new FakeParam()) {
    super()
    this.gain = gain
  }
}

/** 解码出 `duration` 秒、每秒 100 个样本的单声道声音：样本是一列起伏的数，让波形不是一条直线。 */
const fakeBuffer = (duration: number) => {
  const sampleRate = 100
  const length = Math.round(duration * sampleRate)
  const data = Float32Array.from(
    { length },
    (_, index) => 0.2 + 0.6 * Math.abs(Math.sin(index / 7)),
  )
  return { duration, sampleRate, length, numberOfChannels: 1, getChannelData: () => data }
}

/** 装上替身：解码出 `duration` 秒的声音，返回出声记录。 */
export const stubWebAudio = ({ duration }: { duration: number }): WebAudioRecord => {
  const played: PlayedSource[] = []
  const master: GainEvent[] = []
  let clock = 0

  class FakeAudioContext {
    readonly destination = new FakeNode()
    readonly state = 'running'
    private masterMade = false
    get currentTime() {
      return clock
    }
    createGain() {
      // 第一个是总音量，之后每次起播各建一个。
      if (this.masterMade) return new FakeGain()
      this.masterMade = true
      return new FakeGain(new FakeParam(master))
    }
    createBufferSource() {
      const source = new FakeNode() as FakeNode & {
        buffer: unknown
        start: (when: number, offset: number, duration?: number) => void
        stop: () => void
      }
      let record: PlayedSource | undefined
      source.connect = <T>(target: T): T => {
        if (target instanceof FakeGain && record === undefined)
          record = {
            when: 0,
            offset: 0,
            duration: undefined,
            gain: target.gain.events,
            stopped: false,
          }
        return target
      }
      source.start = (when, offset, length) => {
        if (record === undefined) throw new Error('起播前没有接到增益上')
        Object.assign(record, { when, offset, duration: length })
        played.push(record)
      }
      source.stop = () => {
        if (record !== undefined) record.stopped = true
      }
      return source
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  }

  class FakeOfflineAudioContext {
    decodeAudioData() {
      return Promise.resolve(fakeBuffer(duration))
    }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  return {
    played,
    master,
    advance: (seconds) => {
      clock += seconds
    },
  }
}
