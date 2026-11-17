import { useState } from 'react'
import { HF_AUDIO_EQ_RANGE_DB } from '@hyperframes/core/audio-fx-eq'
import type { HfAudioFxChain } from '@hyperframes/core/audio-fx'
import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/icons'
import { parseParamText } from './fx-params'
import { SliderControl } from './inspector-controls'
import {
  eqBandsOf,
  fineTuneSummary,
  pitchOf,
  PITCH_RANGE,
  withEqGain,
  withoutTone,
  withPitch,
  type ChainChange,
} from './mix-fx'
import { EQ_BAND_NAMES } from './mix-fx-names'
import { MixEffects } from './smart-mix-effects'

// 均衡滑杆照参照的工作台每格 0.5 dB；升降调每格一个半音
const EQ_STEP = 0.5

const signed = (value: number, digits: number) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
const gainText = (gain: number) => `${signed(gain, 1)}dB`
const pitchText = (semitones: number) => `${signed(semitones, 0)}半音`
const hzText = (hz: number) => (hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`)
const clamp = (value: number, range: number) => Math.min(range, Math.max(-range, value))

/**
 * 「精细调音」抽屉：默认收起，右边一句摘要（见 `fineTuneSummary`）。展开是「三段均衡与升降调」和「串联效果器链」。
 */
export function MixFineTune({
  chain,
  onChange,
  onEditing,
}: {
  chain: HfAudioFxChain
  onChange: (change: ChainChange) => void
  onEditing: (editing: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const summary = fineTuneSummary(chain)
  return (
    <div className="wf-mix-fine">
      <button
        aria-expanded={open}
        className="wf-mix-fine-toggle ui-focus"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Icon
          className={cn('wf-mix-fine-icon', open && 'is-open')}
          decorative
          name="disclosure"
          size="xs"
        />
        <span>精细调音</span>
        <span className={cn('wf-mix-fine-summary', summary !== '默认' && 'is-tuned')}>
          {summary}
        </span>
      </button>
      {open ? (
        <div className="wf-mix-fine-body">
          <MixTone chain={chain} onChange={onChange} onEditing={onEditing} />
          <MixEffects chain={chain} onChange={onChange} onEditing={onEditing} />
        </div>
      ) : null}
    </div>
  )
}

/** 「三段均衡与升降调」：低、中、高三段（频率照 core）和升降调；双击滑杆归零，右上「归零」全部清掉。 */
function MixTone({
  chain,
  onChange,
  onEditing,
}: {
  chain: HfAudioFxChain
  onChange: (change: ChainChange) => void
  onEditing: (editing: boolean) => void
}) {
  const bands = eqBandsOf(chain)
  const pitch = pitchOf(chain)
  const tuned = pitch !== 0 || bands.some((band) => band.gain !== 0)
  const gainSteps = HF_AUDIO_EQ_RANGE_DB / EQ_STEP
  return (
    <div className="wf-mix-card">
      <div className="wf-prop-title-row">
        <span className="wf-mix-card-title">三段均衡与升降调</span>
        {tuned ? (
          <button
            className="wf-mix-link ui-state ui-focus"
            onClick={() => onChange(withoutTone)}
            type="button"
          >
            归零
          </button>
        ) : null}
      </div>
      {bands.map((band) => {
        const label = `${EQ_BAND_NAMES[band.name] ?? band.name} ${hzText(band.frequency)}`
        const write = (gain: number) => onChange((current) => withEqGain(current, band.name, gain))
        return (
          <div className="wf-prop-row is-tone" key={band.name}>
            <span className="wf-prop-label">{label}</span>
            <SliderControl
              format={(position) => gainText((position - gainSteps) * EQ_STEP)}
              label={label}
              mark={gainSteps}
              max={gainSteps * 2}
              min={0}
              onCommit={(position) => write((position - gainSteps) * EQ_STEP)}
              onDoubleClick={() => write(0)}
              onEditing={onEditing}
              onText={(text) => {
                const typed = parseParamText(text)
                if (typed === null) return false
                write(clamp(Math.round(typed / EQ_STEP) * EQ_STEP, HF_AUDIO_EQ_RANGE_DB))
                return true
              }}
              position={Math.round(band.gain / EQ_STEP) + gainSteps}
              text={gainText(band.gain)}
            />
          </div>
        )
      })}
      <div className="wf-prop-row is-tone wf-mix-pitch">
        <span className="wf-prop-label">升降音调</span>
        <SliderControl
          format={(position) => pitchText(position - PITCH_RANGE)}
          label="升降音调"
          mark={PITCH_RANGE}
          max={PITCH_RANGE * 2}
          min={0}
          onCommit={(position) => onChange((current) => withPitch(current, position - PITCH_RANGE))}
          onDoubleClick={() => onChange((current) => withPitch(current, 0))}
          onEditing={onEditing}
          onText={(text) => {
            const typed = parseParamText(text)
            if (typed === null) return false
            const semitones = clamp(Math.round(typed), PITCH_RANGE)
            onChange((current) => withPitch(current, semitones))
            return true
          }}
          position={pitch + PITCH_RANGE}
          text={pitchText(pitch)}
        />
      </div>
    </div>
  )
}
