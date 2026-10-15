/** 编辑器读视频文件的地方：读关键帧表给时间线分段，解码原声轨给波形，按选用素材裁剪、
 * 拼接 AI 编辑所需的参考片段。只认成片的容器：MP4 与同族的 MOV。
 *
 * 本模块静态引入 mediabunny，只经动态 `import()` 加载，打包时与 mediabunny 用到的部分一起摇成一个
 * 懒加载块，不进首屏包。mediabunny 按 MPL-2.0 发布，许可全文与源码地址见
 * public/licenses/mediabunny.txt（随产物发布）。 */

import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  EncodedPacketSink,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  Quality,
  UrlSource,
  VideoSampleSink,
  VideoSampleSource,
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
    throw asUserFacing(cause, '该视频的关键帧读取失败，请稍后重试')
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
    throw asUserFacing(cause, '原声读取失败，请稍后重试')
  } finally {
    input.dispose()
  }
}

/**
 * 按顺序裁剪、拼接当前选用的素材；起止是各素材自己的秒数，输出从 0 开始，长度为各选区之和。
 * 解码后按精确边界重新编码，允许非关键帧裁剪、不同片长与不同源编码。画幅沿第一段，其他段等比
 * 缩放并补黑边；各段原声保留到对应时刻，无音轨的段保持无声。输出为 MP4，视频优先 AVC、浏览器
 * 不支持时用 VP9，原声用 Opus。
 *
 * 有音轨却无法解码或编码时明确失败，不丢掉声音继续提交。
 */
export const concatenateReferenceClips = async (
  clips: readonly (SecondsRange & { mediaUrl: string })[],
): Promise<File> => {
  if (
    clips.length === 0 ||
    clips.some(
      ({ start, end }) =>
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start,
    )
  ) {
    throw new UserFacingError('参考片段区间无效，请重新选择片段')
  }

  const inputs: Input[] = []
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  try {
    const sources = []
    let numberOfChannels = 0
    for (const clip of clips) {
      const input = openInput(clip.mediaUrl)
      inputs.push(input)
      const [video, audio] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ])
      if (video === null) throw new UserFacingError('所选片段没有画面，无法制作参考视频')
      if (!(await video.canDecode())) {
        throw new UserFacingError('当前浏览器无法解码所选片段的画面')
      }
      // 分段时长来自整个容器；原声音轨可能比画面略长，这段合法尾音也必须保留。
      if (clip.end > roundToMs(await input.computeDuration())) {
        throw new UserFacingError('所选区间超出视频时长，请重新选择片段')
      }
      if (audio !== null) {
        if (!(await audio.canDecode())) {
          throw new UserFacingError('当前浏览器无法解码所选片段的原声')
        }
        numberOfChannels = Math.max(numberOfChannels, await audio.getNumberOfChannels())
      }
      sources.push({ ...clip, video, audio })
    }

    const first = sources[0]
    if (first === undefined) throw new UserFacingError('请先选择参考片段')
    // AVC 要求偶数尺寸；保留首段画幅，不裁掉其他片段的内容。
    const width = Math.ceil((await first.video.getDisplayWidth()) / 2) * 2
    const height = Math.ceil((await first.video.getDisplayHeight()) / 2) * 2
    const quality = new Quality('high')
    const codec = (await canEncodeVideo('avc', { width, height, quality }))
      ? 'avc'
      : (await canEncodeVideo('vp9', { width, height, quality }))
        ? 'vp9'
        : null
    if (codec === null) {
      throw new UserFacingError('当前浏览器无法编码参考视频，请使用支持视频编码的浏览器')
    }
    const videoSource = new VideoSampleSource({
      codec,
      quality,
      sizeChangeBehavior: 'contain',
      transform: { width, height },
    })
    output.addVideoTrack(videoSource)

    const duration = clips.reduce((total, clip) => total + clip.end - clip.start, 0)
    const sampleRate = 48000
    let audioContext: OfflineAudioContext | undefined
    let audioSource: AudioSampleSource | undefined
    if (numberOfChannels > 0) {
      if (
        typeof OfflineAudioContext === 'undefined' ||
        !(await canEncodeAudio('opus', { numberOfChannels, sampleRate }))
      ) {
        throw new UserFacingError('当前浏览器无法编码参考视频的原声，请使用支持音频编码的浏览器')
      }
      // 不同素材的采样率与声道数可能不同，交给 Web Audio 统一；时间戳保留原声的延迟与无声区间。
      audioContext = new OfflineAudioContext(
        numberOfChannels,
        Math.ceil(duration * sampleRate),
        sampleRate,
      )
      // WebCodecs 的 AAC 编码不提供 priming 信息，会把声音推迟；Opus 保持声音起点准确。
      audioSource = new AudioSampleSource({ codec: 'opus', quality: new Quality('high') })
      output.addAudioTrack(audioSource)
    }

    await output.start()
    let offset = 0
    for (const clip of sources) {
      let hasVideo = false
      for await (const sample of new VideoSampleSink(clip.video).samples(clip.start, clip.end)) {
        try {
          const start = Math.max(clip.start, sample.timestamp)
          const end = Math.min(clip.end, sample.timestamp + sample.duration)
          if (end <= start) continue
          sample.setTimestamp(offset + start - clip.start)
          sample.setDuration(end - start)
          await videoSource.add(sample, { keyFrame: !hasVideo })
          hasVideo = true
        } finally {
          sample.close()
        }
      }
      if (!hasVideo) throw new UserFacingError('所选区间没有可播放的画面，请重新选择片段')
      if (audioContext !== undefined && clip.audio !== null) {
        for await (const sample of new AudioSampleSink(clip.audio).samples(clip.start, clip.end)) {
          try {
            const start = Math.max(clip.start, sample.timestamp)
            const end = Math.min(clip.end, sample.timestamp + sample.duration)
            if (end <= start) continue
            const source = audioContext.createBufferSource()
            source.buffer = sample.toAudioBuffer()
            source.connect(audioContext.destination)
            source.start(offset + start - clip.start, start - sample.timestamp, end - start)
          } finally {
            sample.close()
          }
        }
      }
      offset += clip.end - clip.start
    }
    videoSource.close()
    if (audioContext !== undefined && audioSource !== undefined) {
      const audio = await audioContext.startRendering()
      for (const sample of AudioSample.fromAudioBuffer(audio, 0)) {
        try {
          await audioSource.add(sample)
        } finally {
          sample.close()
        }
      }
      audioSource.close()
    }
    await output.finalize()
    if (target.buffer === null) throw new Error('参考片段制作完成却没有产物')
    return new File([target.buffer], 'reference-clip.mp4', { type: 'video/mp4' })
  } catch (cause) {
    throw asUserFacing(cause, '参考片段制作失败，请稍后重试')
  } finally {
    try {
      if (output.state !== 'finalized') await output.cancel()
    } finally {
      for (const input of inputs) input.dispose()
    }
  }
}
