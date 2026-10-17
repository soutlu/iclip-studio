import { beforeEach, describe, expect, it, vi } from 'vitest'
import { errorMessageOf } from '@/shared/api/client'
import { readAudioPeaks, readKeyframes } from './media-file'

type FakeAudio = { timestamp: number; sampleRate: number; channels: number[][] }

const media = vi.hoisted(() => ({
  keyframes: [] as number[],
  duration: 0,
  audio: null as FakeAudio[] | null | 'undecodable',
  disposed: 0,
}))

vi.mock('mediabunny', () => {
  type Packet = { timestamp: number }
  class UrlSource {}
  class Input {
    getPrimaryVideoTrack = () => Promise.resolve({})
    getPrimaryAudioTrack = () =>
      Promise.resolve(
        media.audio === null
          ? null
          : { canDecode: () => Promise.resolve(media.audio !== 'undecodable') },
      )
    computeDuration = () => Promise.resolve(media.duration)
    dispose = () => {
      media.disposed += 1
    }
  }
  class AudioSampleSink {
    async *samples() {
      for (const block of Array.isArray(media.audio) ? media.audio : []) {
        yield {
          timestamp: block.timestamp,
          sampleRate: block.sampleRate,
          numberOfFrames: block.channels[0]?.length ?? 0,
          numberOfChannels: block.channels.length,
          copyTo: (target: Float32Array, options: { planeIndex: number }) =>
            target.set(block.channels[options.planeIndex] ?? []),
          close: () => {},
        }
      }
    }
  }
  class EncodedPacketSink {
    getFirstKeyPacket = () => Promise.resolve(this.at(0))
    getNextKeyPacket = (packet: Packet) =>
      Promise.resolve(this.at(media.keyframes.indexOf(packet.timestamp) + 1))
    private at = (index: number): Packet | null => {
      const timestamp = media.keyframes[index]
      return timestamp === undefined ? null : { timestamp }
    }
  }
  return { AudioSampleSink, EncodedPacketSink, Input, MP4: {}, QTFF: {}, UrlSource }
})

describe('readKeyframes', () => {
  beforeEach(() => {
    Object.assign(media, { keyframes: [0, 1.916667, 4.208333, 6.5], duration: 8.0416, disposed: 0 })
  })

  it('关键帧表与时长都取整到毫秒，读完释放', async () => {
    expect(await readKeyframes('https://oss.example.com/take.mp4')).toEqual({
      keyframes: [0, 1.917, 4.208, 6.5],
      duration: 8.042,
    })
    expect(media.disposed).toBe(1)
  })

  it.each([0, -1, Infinity, NaN])('拒绝无效时长 %s 并释放媒体', async (duration) => {
    media.duration = duration
    await expect(readKeyframes('https://oss.example.com/take.mp4')).rejects.toThrow('视频时长无效')
    expect(media.disposed).toBe(1)
  })
})

describe('readAudioPeaks', () => {
  beforeEach(() => {
    media.disposed = 0
  })

  it('每秒 50 个峰值，各声道取最大的绝对值，整条最响的是 1', async () => {
    // 采样率 100：每个峰值管两个样本。
    media.audio = [
      {
        timestamp: 0,
        sampleRate: 100,
        channels: [
          [0.1, -0.2, 0.05, 0],
          [0, 0.1, -0.4, 0],
        ],
      },
      {
        timestamp: 0.04,
        sampleRate: 100,
        channels: [
          [0.8, 0],
          [0, 0],
        ],
      },
    ]
    expect(await readAudioPeaks('https://oss.example.com/take.mp4')).toEqual({
      rate: 50,
      // 样本按 32 位浮点存，比值只到浮点精度。
      peaks: [expect.closeTo(0.25), expect.closeTo(0.5), 1],
    })
    expect(media.disposed).toBe(1)
  })

  it('没有音轨就是无声，返回 null', async () => {
    media.audio = null
    expect(await readAudioPeaks('https://oss.example.com/take.mp4')).toBeNull()
  })

  it('有音轨却解不了是错误，不当成无声', async () => {
    media.audio = 'undecodable'
    const error = await readAudioPeaks('https://oss.example.com/take.mp4').then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(errorMessageOf(error, '兜底')).toBe('当前浏览器无法解码该视频的原声')
    expect(media.disposed).toBe(1)
  })
})
