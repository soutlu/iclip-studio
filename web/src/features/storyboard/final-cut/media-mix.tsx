import { RATE_RANGE } from '@hyperframes/core/audio-automation'
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioFaderPositionToGain,
  audioGainToFaderPosition,
  audioGainToText,
  formatAudioGain,
} from '@hyperframes/core/audio-gain'
import type { MediaClip, VideoClip } from './composition/film'
import { SliderControl } from './inspector-controls'
import { originalSoundBlocked, originalSoundChanges, type AttributeChanges } from './original-sound'
import { PropSection, PropSwitch } from './ui/prop-layout'
import {
  parseGainInput,
  parseRateInput,
  parseSecondsInput,
} from './vendor/hyperframes-studio/components/editor/audioInspectorInput'
import { formatNumericValue } from './vendor/hyperframes-studio/components/editor/propertyPanelHelpers'
import {
  fromUnit,
  toUnit,
} from './vendor/hyperframes-studio/player/components/automationLaneGeometry'

// 倍速滑杆的格数：照参照的工作台，0.1–10 倍按对数铺满 1000 格，正中是 1 倍
const RATE_STEPS = 1000

const secondsText = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`

/** 输入框里的秒数（后面的「秒」可带可不带）按参照的工作台读成毫秒；读不出时是 null。 */
const parseSecondsText = (text: string): number | null => {
  const seconds = parseSecondsInput(text.trim().replace(/秒$/, ''))
  return seconds === null ? null : Math.round(seconds * 1000)
}

/** 写进文件的秒数：淡入淡出照参照的工作台留两位小数，0 时去掉。 */
const fadeAttribute = (ms: number) => {
  const rounded = Math.round(ms / 10) * 10
  return rounded > 0 ? String(rounded / 1000) : null
}

const rateText = (rate: number) => `${formatNumericValue(rate)}x`
const rateAt = (position: number) => fromUnit(RATE_RANGE, position / RATE_STEPS)
const ratePosition = (rate: number) => Math.round(toUnit(RATE_RANGE, rate) * RATE_STEPS)

/**
 * 「保留原声」：视频片段的原声开着没有（关着写 `muted`，见 `originalSoundChanges`）；素材确认没有声音时开不了，
 * 悬停说明原因。
 */
export function OriginalSoundSwitch({
  clip,
  silent,
  onChange,
}: {
  clip: VideoClip
  /** 素材确认没有声音。 */
  silent: boolean
  onChange: (changes: AttributeChanges) => void
}) {
  return (
    <PropSwitch
      blockedReason={originalSoundBlocked(clip, silent)}
      checked={!clip.muted}
      label="保留原声"
      onChange={(keep) => onChange(originalSoundChanges(!keep))}
    />
  )
}

/**
 * 「音量」滑杆：照参照的工作台按推子位置走，最右 +12 dB、最左无声，正中一道 0 dB 刻度，双击回到 0 dB，点数值可按
 * dB 直接输入。关了原声的视频片段不能操作。
 */
export function VolumeSlider({
  clip,
  onChange,
  onEditing,
}: {
  clip: MediaClip
  onChange: (changes: AttributeChanges) => void
  onEditing: (editing: boolean) => void
}) {
  const setGain = (gain: number) => onChange({ 'data-volume': formatAudioGain(gain) })
  return (
    <SliderControl
      disabled={clip.kind === 'video' && clip.muted}
      format={(position) => audioGainToText(audioFaderPositionToGain(position))}
      label="音量"
      mark={audioGainToFaderPosition(1)}
      max={AUDIO_GAIN_FADER_MAX}
      min={AUDIO_GAIN_FADER_MIN}
      onCommit={(position) => setGain(audioFaderPositionToGain(position))}
      onDoubleClick={() => setGain(1)}
      onEditing={onEditing}
      onText={(text) => {
        const gain = parseGainInput(text)
        if (gain === null) return false
        setGain(gain)
        return true
      }}
      position={audioGainToFaderPosition(clip.volume)}
      text={audioGainToText(clip.volume)}
    />
  )
}

/**
 * 「声音与节奏」：音量（`withVolume` 时；配乐的音量排在最上面，这里不再放）、淡入、淡出、倍速一行一条，最后是开关：
 * 分离出来的原声是「静音此段」（给了 `onMute` 时），别的音频片段是「循环播放」，视频片段没有（原声的开关见
 * `OriginalSoundSwitch`）。换算和上下限照参照的工作台；拖滑杆时只动这里，松手（或按一下方向键）才写进 final-cut，
 * 一次算一步撤销。关了原声的视频片段音量、淡入、淡出变淡、不能操作。
 */
export function MediaMix({
  clip,
  withVolume,
  onChange,
  onEditing,
  onMute,
}: {
  clip: MediaClip
  withVolume: boolean
  onChange: (changes: AttributeChanges) => void
  onEditing: (editing: boolean) => void
  /** 「静音此段」改成开或关：静音就是片段的隐藏标记（`clip.hidden`）。 */
  onMute?: ((muted: boolean) => void) | undefined
}) {
  const { duration, fadeIn, fadeOut } = clip
  const muted = clip.kind === 'video' && clip.muted
  const fade = (name: 'data-fade-in' | 'data-fade-out', ms: number, other: number) => {
    // 照参照的工作台：一端最多到片段长减去另一端
    const max = Math.max(0, duration - other)
    const label = name === 'data-fade-in' ? '淡入' : '淡出'
    return (
      <SliderControl
        disabled={muted}
        format={(position) => secondsText(position * 10)}
        label={label}
        max={Math.round(max / 10)}
        min={0}
        onCommit={(position) => onChange({ [name]: fadeAttribute(position * 10) })}
        onEditing={onEditing}
        onText={(text) => {
          const typed = parseSecondsText(text)
          if (typed === null) return false
          onChange({ [name]: fadeAttribute(Math.min(typed, max)) })
          return true
        }}
        position={Math.round(ms / 10)}
        text={secondsText(ms)}
      />
    )
  }
  return (
    <PropSection title="声音与节奏">
      {withVolume ? <VolumeSlider clip={clip} onChange={onChange} onEditing={onEditing} /> : null}
      {fade('data-fade-in', fadeIn, fadeOut)}
      {fade('data-fade-out', fadeOut, fadeIn)}
      <RateSlider onChange={onChange} onEditing={onEditing} rate={clip.playbackRate} />
      {onMute !== undefined ? (
        <PropSwitch checked={clip.hidden} label="静音此段" onChange={onMute} />
      ) : clip.kind === 'audio' ? (
        <PropSwitch
          checked={clip.loop}
          label="循环播放"
          onChange={(loop) => onChange({ loop: loop ? 'true' : null })}
        />
      ) : null}
    </PropSection>
  )
}

/**
 * 「倍速」滑杆：照参照的工作台 0.1–10 倍按对数铺满，正中 1 倍，双击回到 1 倍，点数值可以直接输入；1 倍时去掉这个
 * 属性。改的是 `data-playback-rate`，联动的伙伴由编辑器一起改；片段在 final-cut 里的时长不变，用掉的素材跟着变长
 * 或变短。
 */
export function RateSlider({
  rate,
  onChange,
  onEditing,
}: {
  rate: number
  onChange: (changes: AttributeChanges) => void
  onEditing: (editing: boolean) => void
}) {
  const setRate = (next: number) => {
    const written = formatNumericValue(next)
    onChange({ 'data-playback-rate': written === '1' ? null : written })
  }
  return (
    <SliderControl
      format={(position) => rateText(rateAt(position))}
      label="倍速"
      mark={ratePosition(1)}
      max={RATE_STEPS}
      min={0}
      onCommit={(position) => setRate(rateAt(position))}
      onDoubleClick={() => setRate(1)}
      onEditing={onEditing}
      onText={(text) => {
        const typed = parseRateInput(text)
        if (typed === null) return false
        setRate(typed)
        return true
      }}
      position={ratePosition(rate)}
      text={rateText(rate)}
    />
  )
}
