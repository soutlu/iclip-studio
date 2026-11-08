// mediabunny 按 MPL-2.0 发布，许可全文与源码地址见 public/licenses/mediabunny.txt（随产物发布）。

import {
  AudioSampleSink,
  EncodedPacketSink,
  Input,
  MP4,
  QTFF,
  UrlSource,
  type AudioSample,
  type InputAudioTrack,
} from 'mediabunny'
import { UserFacingError } from '@/shared/api/client'
import { peakCollector, type AudioPeaks } from './audio-peaks'
import { roundToMs } from './clip'
import type { KeyframeIndex } from './keyframe-segments'

const METADATA_ONLY = { metadataOnly: true } as const

export const openInput = (url: string) =>
  new Input({ source: new UrlSource(url), formats: [MP4, QTFF] })

export const asUserFacing = (cause: unknown, message: string): UserFacingError =>
  cause instanceof UserFacingError ? cause : new UserFacingError(message, { cause })

export const readKeyframes = async (url: string): Promise<KeyframeIndex> => {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (track === null) throw new UserFacingError('该视频没有画面，无法分段')
    const sink = new EncodedPacketSink(track)
    const keyframes = new Set<number>()
    for (
      let packet = await sink.getFirstKeyPacket(METADATA_ONLY);
      packet !== null;
      packet = await sink.getNextKeyPacket(packet, METADATA_ONLY)
    ) {
      keyframes.add(roundToMs(packet.timestamp))
    }
    const duration = roundToMs(await input.computeDuration())
    if (!Number.isFinite(duration) || duration <= 0)
      throw new UserFacingError('视频时长无效，无法分段')
    return {
      keyframes: [...keyframes].sort((left, right) => left - right),
      duration,
    }
  } catch (cause) {
    throw asUserFacing(cause, '该视频的关键帧读取失败，请稍后重试')
  } finally {
    input.dispose()
  }
}

export type AudioTrackReader = {
  numberOfChannels: () => Promise<number>
  duration: () => Promise<number>
  samples: AsyncIterable<AudioSample>
}

async function* decodedSamples(track: InputAudioTrack, signal: AbortSignal | undefined) {
  for await (const sample of new AudioSampleSink(track).samples()) {
    try {
      signal?.throwIfAborted()
      yield sample
    } finally {
      sample.close()
    }
  }
}

export const readAudioTrack = async <T>(
  url: string,
  read: (track: AudioTrackReader) => Promise<T>,
  { failure, signal }: { failure: string; signal?: AbortSignal | undefined },
): Promise<T | null> => {
  const input = openInput(url)
  const abort = () => input.dispose()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    const track = await input.getPrimaryAudioTrack()
    if (track === null) return null
    if (!(await track.canDecode())) throw new UserFacingError('当前浏览器无法解码该视频的原声')
    return await read({
      numberOfChannels: () => track.getNumberOfChannels(),
      duration: () => input.computeDuration([track]),
      samples: decodedSamples(track, signal),
    })
  } catch (cause) {
    signal?.throwIfAborted()
    throw asUserFacing(cause, failure)
  } finally {
    signal?.removeEventListener('abort', abort)
    input.dispose()
  }
}

export const readAudioPeaks = (url: string): Promise<AudioPeaks | null> =>
  readAudioTrack(
    url,
    async ({ samples }) => {
      const collector = peakCollector()
      for await (const sample of samples) {
        const plane = new Float32Array(sample.numberOfFrames)
        for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
          sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
          collector.add(plane, sample.timestamp, sample.sampleRate)
        }
      }
      return collector.result()
    },
    { failure: '原声读取失败，请稍后重试' },
  )
