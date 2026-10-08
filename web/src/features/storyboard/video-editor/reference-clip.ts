/** 编辑器读视频文件的地方（ADR-0010）：读关键帧表给时间线分段，解码原声轨给波形，在关键帧处把
 * AI 改的那一段重封装成参考片段（不重编码）。只认成片的容器：MP4 与同族的 MOV。
 *
 * 本模块静态引入 mediabunny，只经动态 `import()` 加载，打包时与 mediabunny 用到的部分一起摇成一个
 * 懒加载块，不进首屏包。mediabunny 按 MPL-2.0 发布，许可全文与源码地址见
 * public/licenses/mediabunny.txt（随产物发布）。 */

import {
  AudioSampleSink,
  BufferTarget,
  Conversion,
  EncodedPacketSink,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  UrlSource,
} from 'mediabunny'
import { UserFacingError } from '@/shared/api/client'

/** 一段时间，单位秒。 */
export type SecondsRange = { start: number; end: number }

/** 一条视频的关键帧表与时长，秒，都取整到毫秒。 */
export type KeyframeIndex = { keyframes: number[]; duration: number }

/** 原声的波形：每秒 `rate` 个峰值，按时间排，各值在 0–1 之间，整条里最响的是 1。 */
export type AudioPeaks = { rate: number; peaks: number[] }

/** 波形的精度：每秒 50 个峰值，时间线上一秒宽几十像素，够画出起伏。 */
const PEAKS_PER_SECOND = 50

/** 秒取整到毫秒。mediabunny 按各轨的时间基换算出浮点秒（0.99999…）；分段、比对、记录区间都用
 * 取整后的值，同一时刻处处相等，不用到处带容差。 */
const roundToMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

/** 只读样本表、不取帧数据：读关键帧表只要索引。 */
const METADATA_ONLY = { metadataOnly: true } as const

const openInput = (url: string) => new Input({ source: new UrlSource(url), formats: [MP4, QTFF] })

/** 失败一律换成可直接展示的 {@link UserFacingError}，原始错误放在 cause。 */
const asUserFacing = (cause: unknown, message: string): UserFacingError =>
  cause instanceof UserFacingError ? cause : new UserFacingError(message, { cause })

/**
 * 读一条视频的关键帧表与时长。只读索引、不解码。关键帧按时刻排、去重；第一个不在 0 上时，片头
 * 那一截也算一段，由调用方从 0 起分。
 */
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
    return {
      keyframes: [...keyframes].sort((left, right) => left - right),
      duration: roundToMs(await input.computeDuration()),
    }
  } catch (cause) {
    throw asUserFacing(cause, '无法读取该视频的关键帧，请稍后重试')
  } finally {
    input.dispose()
  }
}

/**
 * 解码一条视频的原声，算成波形峰值。没有音轨返回 `null`（这条视频本来无声）；有音轨却解不了
 * 是错误，不当成无声。各声道取最大的绝对值。
 */
export const readAudioPeaks = async (url: string): Promise<AudioPeaks | null> => {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryAudioTrack()
    if (track === null) return null
    if (!(await track.canDecode())) throw new UserFacingError('当前浏览器无法解码该视频的原声')
    const peaks: number[] = []
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        const plane = new Float32Array(sample.numberOfFrames)
        for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
          sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
          plane.forEach((value, frame) => {
            const bucket = Math.floor(
              (sample.timestamp + frame / sample.sampleRate) * PEAKS_PER_SECOND,
            )
            if (bucket >= 0) peaks[bucket] = Math.max(peaks[bucket] ?? 0, Math.abs(value))
          })
        }
      } finally {
        sample.close()
      }
    }
    const filled = Array.from(peaks, (peak) => peak ?? 0)
    const loudest = Math.max(0, ...filled)
    return {
      rate: PEAKS_PER_SECOND,
      peaks: loudest === 0 ? filled : filled.map((peak) => peak / loudest),
    }
  } catch (cause) {
    throw asUserFacing(cause, '无法读取原声，请稍后重试')
  } finally {
    input.dispose()
  }
}

export type ReferenceClip = {
  /** 切好的片段，MP4 容器。 */
  file: File
  /** 区间，毫秒；编辑请求的 `range_start_ms` / `range_end_ms` 就填它。 */
  startMs: number
  endMs: number
}

/**
 * 从基底 `baseUrl` 上切出 `range` 那一段。`range` 的两端必须正好是基底的关键帧（或片尾），取自
 * {@link readKeyframes}：只在关键帧处下刀，才不用重编码，切出来的长度也正好是区间长。
 *
 * 只拷贝不转码：有哪条轨拷不进 MP4 就报错，不静默转码、不丢轨。
 */
export const cutReferenceClip = async (
  baseUrl: string,
  range: SecondsRange,
): Promise<ReferenceClip> => {
  const input = openInput(baseUrl)
  try {
    const target = new BufferTarget()
    const conversion = await Conversion.init({
      input,
      output: new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target }),
      trim: range,
      copy: { mode: 'forced' },
      showWarnings: false,
    })
    if (!conversion.isValid || conversion.discardedTracks.length > 0) {
      const reasons = conversion.discardedTracks.map((discarded) => discarded.reason)
      throw new Error(`这条视频有轨道没法原样拷进 MP4：${reasons.join('、')}`)
    }
    await conversion.execute()
    if (target.buffer === null) throw new Error('切片完成了却没有产物')
    return {
      file: new File([target.buffer], 'reference-clip.mp4', { type: 'video/mp4' }),
      startMs: Math.round(range.start * 1000),
      endMs: Math.round(range.end * 1000),
    }
  } catch (cause) {
    throw asUserFacing(cause, '参考片段截取失败，请稍后重试')
  } finally {
    input.dispose()
  }
}
