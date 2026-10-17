// mediabunny 按 MPL-2.0 发布，许可全文与源码地址见 public/licenses/mediabunny.txt（随产物发布）。

import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  VideoSampleSource,
  type Input,
} from 'mediabunny'
import { UserFacingError } from '@/shared/api/client'
import { roundToMs, type SecondsRange } from '../editing/clip'
import { asUserFacing, openInput } from '../editing/media-file'

type ReferenceClip = SecondsRange & { mediaUrl: string }

const isNonEmpty = <T>(items: readonly T[]): items is readonly [T, ...T[]] => items.length > 0

const isValidRange = ({ start, end }: SecondsRange) =>
  Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start

const openSource = async (clip: ReferenceClip, inputs: Input[]) => {
  const input = openInput(clip.mediaUrl)
  inputs.push(input)
  const [video, audio] = await Promise.all([
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
  ])
  if (video === null)
    throw new UserFacingError('所选片段没有画面，无法制作参考视频；请重新选择片段')
  if (!(await video.canDecode()))
    throw new UserFacingError(
      '当前浏览器不支持解码所选片段的画面，无法制作参考视频；请使用其他浏览器',
    )
  // 容器时长可能长于画面：原声音轨比画面略长时，这段尾音也属于素材。
  if (clip.end > roundToMs(await input.computeDuration()))
    throw new UserFacingError('所选区间超出视频时长，无法制作参考视频；请重新选择片段')
  if (audio !== null && !(await audio.canDecode()))
    throw new UserFacingError(
      '当前浏览器不支持解码所选片段的原声，无法制作参考视频；请使用其他浏览器',
    )
  const channels = audio === null ? 0 : await audio.getNumberOfChannels()
  return { ...clip, video, audio, channels }
}

export const concatenateReferenceClips = async (clips: readonly ReferenceClip[]): Promise<File> => {
  if (!isNonEmpty(clips) || !clips.every(isValidRange))
    throw new UserFacingError('参考片段区间无效，无法制作参考视频；请重新选择片段')

  const inputs: Input[] = []
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  try {
    const [head, ...rest] = clips
    const first = await openSource(head, inputs)
    const sources = [first]
    for (const clip of rest) sources.push(await openSource(clip, inputs))
    const numberOfChannels = Math.max(...sources.map((source) => source.channels))

    // AVC 要求偶数尺寸。
    const width = Math.ceil((await first.video.getDisplayWidth()) / 2) * 2
    const height = Math.ceil((await first.video.getDisplayHeight()) / 2) * 2
    const quality = new Quality('high')
    const codec = (await canEncodeVideo('avc', { width, height, quality }))
      ? 'avc'
      : (await canEncodeVideo('vp9', { width, height, quality }))
        ? 'vp9'
        : null
    if (codec === null) {
      throw new UserFacingError(
        '当前浏览器不支持视频编码，无法制作参考视频；请使用支持视频编码的浏览器',
      )
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
        throw new UserFacingError(
          '当前浏览器不支持音频编码，无法制作参考视频的原声；请使用支持音频编码的浏览器',
        )
      }
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
      if (!hasVideo)
        throw new UserFacingError('所选区间没有可播放的画面，无法制作参考视频；请重新选择片段')
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
