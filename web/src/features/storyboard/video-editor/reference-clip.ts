/** 编辑段的参考片段在浏览器里切（ADR-0010）：读基底的关键帧，把选段吸附到关键帧上，在关键帧处
 * 重封装成 MP4，不重编码。
 *
 * 本模块静态引入 mediabunny，只由提交路径动态 `import()`，打包时与 mediabunny 用到的部分一起
 * 摇成一个懒加载块，不进首屏包。mediabunny 按 MPL-2.0 发布，许可全文与源码地址见
 * public/licenses/mediabunny.txt（随产物发布）。 */

import {
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

/** 选段端点与关键帧相差不到 1 毫秒就算正好落在关键帧上：两边都是浮点秒，同一时刻从不同的时间基
 * 换算过来可能差一点，不能因此退到前一个关键帧、多切出整整一段。 */
const KEYFRAME_EPSILON = 0.001

/**
 * 把选段吸附到关键帧上：起点退到不晚于它的最近关键帧，终点进到不早于它的最近关键帧，后面没有
 * 关键帧就到片尾 `duration`。片头之前没有关键帧（首个关键帧晚于起点）时从 0 起。
 *
 * 只在关键帧处下刀，切出来的片段才不用重编码；吸附后的区间只会比选段宽，不会窄。
 */
export const snapToKeyframes = (
  keyframes: readonly number[],
  duration: number,
  range: SecondsRange,
): SecondsRange => {
  const sorted = [...keyframes].sort((left, right) => left - right)
  const start = sorted.findLast((time) => time <= range.start + KEYFRAME_EPSILON) ?? 0
  const end = sorted.find((time) => time >= range.end - KEYFRAME_EPSILON) ?? duration
  return { start, end }
}

/** 秒换成记录上的毫秒：四舍五入到最近的毫秒。关键帧时刻落在帧边界上，取整后离真实边界不到半毫秒，
 * 合成按帧取最近的一帧时仍落回同一帧；片段时长与区间长度也只差这一点取整。 */
const toMs = (seconds: number): number => Math.round(seconds * 1000)

export type ReferenceClip = {
  /** 切好的片段，MP4 容器。 */
  file: File
  /** 吸附后的区间，毫秒，按 {@link toMs} 取整；编辑请求的 `range_start_ms` / `range_end_ms` 就填它。 */
  startMs: number
  endMs: number
}

/** 只读样本表、不取帧数据：读关键帧表只要索引。 */
const METADATA_ONLY = { metadataOnly: true } as const

/**
 * 从基底 `baseUrl` 上切出吸附到关键帧后的那一段。基底是成片，只认 MP4 与同族的 MOV。
 *
 * 只拷贝不转码：有哪条轨拷不进 MP4 就报错，不静默转码、不丢轨。失败抛 {@link UserFacingError}，
 * message 可直接展示，原始错误放在 cause。
 */
export const cutReferenceClip = async (
  baseUrl: string,
  range: SecondsRange,
): Promise<ReferenceClip> => {
  const input = new Input({ source: new UrlSource(baseUrl), formats: [MP4, QTFF] })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (track === null) throw new UserFacingError('这条视频没有画面，切不出参考片段')
    const sink = new EncodedPacketSink(track)
    const keyframes: number[] = []
    for (
      let packet = await sink.getFirstKeyPacket(METADATA_ONLY);
      packet !== null;
      packet = await sink.getNextKeyPacket(packet, METADATA_ONLY)
    ) {
      keyframes.push(packet.timestamp)
    }
    const snapped = snapToKeyframes(keyframes, await input.computeDuration(), range)
    const target = new BufferTarget()
    const conversion = await Conversion.init({
      input,
      output: new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target }),
      trim: snapped,
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
      startMs: toMs(snapped.start),
      endMs: toMs(snapped.end),
    }
  } catch (cause) {
    if (cause instanceof UserFacingError) throw cause
    throw new UserFacingError('参考片段没切出来，请稍后重试', { cause })
  } finally {
    input.dispose()
  }
}
