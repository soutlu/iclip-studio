import { RATE_RANGE } from '@hyperframes/core/audio-automation'
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioFaderPositionToGain,
  audioGainToFaderPosition,
  audioGainToText,
  formatAudioGain,
} from '@hyperframes/core/audio-gain'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { MediaClip } from './composition/film'
import { SliderControl } from './inspector-controls'
import { originalSoundBlocked, originalSoundChanges, type AttributeChanges } from './original-sound'
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
 * 「声音与节奏」：标题行右边是开关（视频片段的「关闭原声」、分离出来的原声的「静音此段」（给了 `onMute` 时）或别的
 * 音频片段的「循环播放」）和倍速；下面是音量，淡入、淡出并排。换算和上下限照参照的工作台；拖滑杆时只动这里，松手
 * （或按一下方向键）才写进 final-cut，一次算一步撤销。关闭原声后音量、淡入、淡出变淡、不能操作。改倍速不改片段在
 * final-cut 里的时长，用掉的素材跟着变长或变短。
 */
export function MediaMix({
  clip,
  silent,
  onChange,
  onEditing,
  onMute,
  popupContainer,
}: {
  clip: MediaClip
  /** 视频片段的素材确认没有声音。 */
  silent: boolean
  onChange: (changes: AttributeChanges) => void
  onEditing: (editing: boolean) => void
  /** 「静音此段」改成开或关：静音就是片段的隐藏标记（`clip.hidden`）。 */
  onMute?: ((muted: boolean) => void) | undefined
  /** 倍速浮层挂在哪，见 `RatePicker`。 */
  popupContainer: HTMLElement | null
}) {
  const { volume, playbackRate, duration, fadeIn, fadeOut } = clip
  const muted = clip.kind === 'video' && clip.muted
  const setGain = (gain: number) => onChange({ 'data-volume': formatAudioGain(gain) })
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
    <section className="wf-card wf-prop-card">
      <div className="wf-prop-title-row">
        <h4 className="wf-prop-title">声音与节奏</h4>
        <span className="wf-prop-title-end">
          {onMute !== undefined ? (
            <IconSwitch
              checked={clip.hidden}
              icon={clip.hidden ? 'final-cut-sound-off' : 'final-cut-sound-on'}
              label="静音此段"
              onChange={onMute}
              tone="mute"
            />
          ) : clip.kind === 'audio' ? (
            <IconSwitch
              checked={clip.loop}
              icon="final-cut-loop"
              label="循环播放"
              onChange={(loop) => onChange({ loop: loop ? 'true' : null })}
              tone="loop"
            />
          ) : (
            <IconSwitch
              blocked={originalSoundBlocked(clip, silent)}
              checked={clip.muted}
              icon={clip.muted ? 'final-cut-sound-off' : 'final-cut-sound-on'}
              label="关闭原声"
              onChange={(off) => onChange(originalSoundChanges(off))}
              tone="mute"
            />
          )}
          <RatePicker
            container={popupContainer}
            onChange={onChange}
            onEditing={onEditing}
            rate={playbackRate}
          />
        </span>
      </div>
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
      <div className="wf-prop-pair">
        {fade('data-fade-in', fadeIn, fadeOut)}
        {fade('data-fade-out', fadeOut, fadeIn)}
      </div>
    </section>
  )
}

/**
 * 标题行里的图标开关：读屏读作开关（名字是 `label`），悬停提示名字；`blocked` 时置灰、拨不动，悬停说明原因。
 * `tone` 是开着时的颜色：循环用配乐色，静音、关闭原声用警示色。
 */
function IconSwitch({
  label,
  icon,
  checked,
  tone,
  blocked,
  onChange,
}: {
  label: string
  icon: IconName
  checked: boolean
  tone: 'loop' | 'mute'
  blocked?: string | undefined
  onChange: (checked: boolean) => void
}) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <button
          aria-checked={checked}
          aria-disabled={blocked === undefined ? undefined : true}
          aria-label={label}
          className={cn('wf-tool wf-mix-toggle ui-state ui-focus', `is-${tone}`)}
          onClick={() => {
            if (blocked === undefined) onChange(!checked)
          }}
          role="switch"
          type="button"
        >
          <Icon decorative name={icon} size="sm" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        {blocked ?? label}
      </TooltipContent>
    </TooltipRoot>
  )
}

/**
 * 标题行里的倍速：小下拉写着现在的倍速，点开是倍速滑杆（照参照的工作台 0.1–10 倍按对数铺满，双击回到 1 倍，点数值
 * 可以直接输入），1 倍时去掉这个属性。改的是 `data-playback-rate`，联动的伙伴由编辑器一起改。
 * 浮层挂在 `container`（「属性」的根）里：里面按的键和「属性」里别的控件一样不当快捷键。数值框里的 Esc 先交给数值框
 * 放弃输入，不让浮层抢先把正在输入的框拆掉；输完（回车或 Esc）焦点回到编辑器，浮层随之收起。
 */
export function RatePicker({
  rate,
  container,
  onChange,
  onEditing,
}: {
  rate: number
  container: HTMLElement | null
  onChange: (changes: AttributeChanges) => void
  onEditing: (editing: boolean) => void
}) {
  const setRate = (next: number) => {
    const written = formatNumericValue(next)
    onChange({ 'data-playback-rate': written === '1' ? null : written })
  }
  return (
    <PopupRoot>
      <PopupTrigger asChild>
        <button
          aria-label={`倍速：${rateText(rate)}`}
          className="wf-select wf-rate-picker ui-state ui-focus"
          type="button"
        >
          {rateText(rate)}
          <Icon decorative name="final-cut-expand" size="xs" />
        </button>
      </PopupTrigger>
      <PopupSurface
        align="end"
        aria-label="倍速"
        className="wf-menu wf-rate-popup"
        container={container}
        onEscapeKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) event.preventDefault()
        }}
        sideOffset={6}
      >
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
      </PopupSurface>
    </PopupRoot>
  )
}
