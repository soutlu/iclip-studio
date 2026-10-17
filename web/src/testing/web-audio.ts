// jsdom 没有 Web Audio 与 Worker：用 `vi.stubGlobal` 装上替身，`vi.unstubAllGlobals()` 卸下。

import { vi } from 'vitest'

export type GainEvent = { value: number; time: number }

export type PlayedSource = {
  when: number
  offset: number
  duration: number | undefined
  stopped: boolean
}

export type WebAudioRecord = {
  played: PlayedSource[]
  master: GainEvent[]
  advance: (seconds: number) => void
  workers: { terminated: boolean }[]
  closed: number
}

class FakeNode {
  connect<T>(target: T): T {
    return target
  }
  disconnect() {}
}

const fakeBuffer = (duration: number, sampleRate = 100, numberOfChannels = 1) => {
  const length = Math.round(duration * sampleRate)
  const channels = Array.from({ length: numberOfChannels }, () =>
    Float32Array.from({ length }, (_, index) => 0.2 + 0.6 * Math.abs(Math.sin(index / 7))),
  )
  return {
    duration,
    sampleRate,
    length,
    numberOfChannels,
    getChannelData: (index: number) => channels[index],
  }
}

export const stubWebAudio = ({ duration }: { duration: number }): WebAudioRecord => {
  const played: PlayedSource[] = []
  const master: GainEvent[] = []
  const workers: { terminated: boolean }[] = []
  let closed = 0
  let clock = 0

  class FakeAudioContext {
    readonly destination = new FakeNode()
    readonly state = 'running'
    get currentTime() {
      return clock
    }
    createGain() {
      return Object.assign(new FakeNode(), {
        gain: {
          setValueAtTime: (value: number, time: number) => master.push({ value, time }),
        },
      })
    }
    createBufferSource() {
      const record: PlayedSource = { when: 0, offset: 0, duration: undefined, stopped: false }
      return Object.assign(new FakeNode(), {
        buffer: null,
        start: (when: number, offset: number, length?: number) => {
          Object.assign(record, { when, offset, duration: length })
          played.push(record)
        },
        stop: () => {
          record.stopped = true
        },
      })
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      closed += 1
      return Promise.resolve()
    }
  }

  class FakeOfflineAudioContext {
    createBuffer(channels: number, length: number, rate: number) {
      return fakeBuffer(length / rate, rate, channels)
    }
    decodeAudioData() {
      return Promise.resolve(fakeBuffer(duration))
    }
  }

  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    private record = { terminated: false }
    constructor() {
      workers.push(this.record)
    }
    postMessage(data: { segments: { start: number; end: number }[] }) {
      const length = Math.round(
        data.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0) * 48_000,
      )
      queueMicrotask(() => {
        if (!this.record.terminated)
          this.onmessage?.({
            data: {
              pcm: {
                sampleRate: 48_000,
                channels: [new Float32Array(length), new Float32Array(length)],
              },
            },
          })
      })
    }
    terminate() {
      this.record.terminated = true
    }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  vi.stubGlobal('Worker', FakeWorker)
  return {
    played,
    master,
    workers,
    get closed() {
      return closed
    },
    advance: (seconds) => {
      clock += seconds
    },
  }
}
