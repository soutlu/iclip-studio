import { useId, type ReactNode } from 'react'
import { RATE_RANGE } from '@hyperframes/core/audio-automation'
import { DEFAULT_CARVE } from '@hyperframes/core/audio-carve'
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioFaderPositionToGain,
  audioGainToFaderPosition,
  audioGainToText,
  formatAudioGain,
} from '@hyperframes/core/audio-gain'
import { Switch } from '@/shared/ui/switch'
import type { MediaClip } from './composition/film'
import { SliderControl } from './inspector-controls'
import { originalSoundBlocked, originalSoundChanges, type AttributeChanges } from './original-sound'
import type { MusicCarve } from './use-music-carve'
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
 * 「音量与变速」：标题行右边是视频片段的「关闭原声」或音频片段的「循环播放」，下面是音量、淡入、淡出、倍速。
 * 换算和上下限照参照的工作台；拖滑杆时只动这里，松手（或按一下方向键）才写进 final-cut，一次算一步撤销。
 * 关闭原声后前三行变淡、不能操作。改倍速不改片段在 final-cut 里的时长，用掉的素材跟着变长或变短。
 */
export function MediaMix({
  clip,
  silent,
  onChange,
  onEditing,
}: {
  clip: MediaClip
  /** 视频片段的素材确认没有声音。 */
  silent: boolean
  onChange: (changes: AttributeChanges) => void
  onEditing: (editing: boolean) => void
}) {
  const switchId = useId()
  const { volume, playbackRate, duration, fadeIn, fadeOut } = clip
  const muted = clip.kind === 'video' && clip.muted
  const setGain = (gain: number) => onChange({ 'data-volume': formatAudioGain(gain) })
  const fade = (name: 'data-fade-in' | 'data-fade-out', ms: number, other: number) => {
    // 照参照的工作台：一端最多到片段长减去另一端
    const max = Math.max(0, duration - other)
    const label = name === 'data-fade-in' ? '淡入' : '淡出'
    return (
      <Row disabled={muted} label={label}>
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
      </Row>
    )
  }
  return (
    <section className="wf-prop-section">
      <div className="wf-prop-title-row">
        <h4 className="wf-prop-title">音量与变速</h4>
        <span className="wf-prop-switch">
          <label htmlFor={switchId}>{clip.kind === 'audio' ? '循环播放' : '关闭原声'}</label>
          {clip.kind === 'audio' ? (
            <Switch
              checked={clip.loop}
              id={switchId}
              onCheckedChange={(loop) => onChange({ loop: loop ? 'true' : null })}
            />
          ) : (
            <Switch
              blockedReason={originalSoundBlocked(clip, silent)}
              checked={clip.muted}
              id={switchId}
              onCheckedChange={(off) => onChange(originalSoundChanges(off))}
            />
          )}
        </span>
      </div>
      <div className="wf-prop-rows">
        <Row disabled={muted} label="音量">
          <SliderControl
            disabled={muted}
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
            position={audioGainToFaderPosition(volume)}
            text={audioGainToText(volume)}
          />
        </Row>
        {fade('data-fade-in', fadeIn, fadeOut)}
        {fade('data-fade-out', fadeOut, fadeIn)}
        <RateRow onChange={onChange} onEditing={onEditing} rate={playbackRate} />
      </div>
    </section>
  )
}

// 强度照参照的工作台：0–1，每格 0.05，显示成百分比
const STRENGTH_STEPS = 20
const strengthText = (strength: number) => `${Math.round(strength * 100)}%`
const PERCENT = /^(\d+(?:\.\d+)?)\s*%?$/

/**
 * 配乐片段的「有人说话时自动压低」：标题行右边是开关，开着时下面是强度。拖强度时只动这里，松手（或按一下方向键）
 * 才交出去；分析人声期间开关和强度都不能改。
 */
export function CarveSection({
  carve,
  onEditing,
}: {
  carve: MusicCarve
  onEditing: (editing: boolean) => void
}) {
  const titleId = useId()
  const on = carve.settings?.enabled === true
  const strength = carve.settings?.strength ?? DEFAULT_CARVE.strength
  return (
    <section className="wf-prop-section">
      <div className="wf-prop-title-row">
        <h4 className="wf-prop-title" id={titleId}>
          有人说话时自动压低
        </h4>
        {carve.analysing ? (
          <span className="wf-prop-subtitle" role="status">
            正在分析人声
          </span>
        ) : null}
        <span className="wf-prop-switch">
          <Switch
            aria-labelledby={titleId}
            blockedReason={carve.analysing ? '正在分析人声，请稍候' : undefined}
            checked={on}
            onCheckedChange={carve.setEnabled}
          />
        </span>
      </div>
      {on ? (
        <div className="wf-prop-rows">
          <Row disabled={carve.analysing} label="强度">
            <SliderControl
              disabled={carve.analysing}
              format={(position) => strengthText(position / STRENGTH_STEPS)}
              label="强度"
              max={STRENGTH_STEPS}
              min={0}
              onCommit={(position) => carve.setStrength(position / STRENGTH_STEPS)}
              onEditing={onEditing}
              onText={(text) => {
                const typed = PERCENT.exec(text)?.[1]
                if (typed === undefined) return false
                carve.setStrength(Math.min(100, Number(typed)) / 100)
                return true
              }}
              position={Math.round(strength * STRENGTH_STEPS)}
              text={strengthText(strength)}
            />
          </Row>
        </div>
      ) : null}
    </section>
  )
}

/**
 * 「倍速」一行：照参照的工作台 0.1–10 倍按对数铺满滑杆，双击回到 1 倍，1 倍时去掉这个属性。
 * 改的是 `data-playback-rate`，联动的伙伴由编辑器一起改。
 */
export function RateRow({
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
    <Row disabled={false} label="倍速">
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
    </Row>
  )
}

function Row({
  label,
  disabled,
  children,
}: {
  label: string
  disabled: boolean
  children: ReactNode
}) {
  return (
    <div className="wf-prop-row is-mix" data-disabled={disabled || undefined}>
      <span className="wf-prop-label">{label}</span>
      {children}
    </div>
  )
}
