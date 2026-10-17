import { useId, useRef } from 'react'
import { Button, IconButton } from '@/shared/ui/button'
import { BlockedReason } from '../components/blocked-reason'
import { MAX_VOLUME } from './film-limits'

type VolumeControlProps = {
  label: string
  volume: number
  disabled: boolean
  onChange: (volume: number, edit: string) => void
}

function VolumeControl({ label, volume, disabled, onChange }: VolumeControlProps) {
  const id = useId()
  const gestureRef = useRef(0)
  const audibleRef = useRef(1)
  const change = (value: number) => {
    if (value > 0) audibleRef.current = value
    onChange(value, `${id}:${gestureRef.current}`)
  }
  const percent = Math.round(volume * 100)
  return (
    <div className="film-volume-control">
      <IconButton
        disabled={disabled}
        label={volume === 0 ? `恢复${label}` : `静音${label}`}
        name={volume === 0 ? 'audio-off' : 'audio'}
        onClick={() => {
          gestureRef.current += 1
          if (volume > 0) audibleRef.current = volume
          change(volume === 0 ? audibleRef.current : 0)
        }}
        size="sm"
      />
      <label htmlFor={id}>{label}</label>
      <input
        aria-valuetext={`${percent}%`}
        className="film-volume-slider ui-focus"
        disabled={disabled}
        id={id}
        max={MAX_VOLUME * 100}
        min={0}
        onChange={(event) => change(Number(event.currentTarget.value) / 100)}
        onKeyDown={(event) => {
          if (
            [
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
              'Home',
              'End',
              'PageUp',
              'PageDown',
            ].includes(event.key)
          ) {
            if (!event.repeat) gestureRef.current += 1
            event.stopPropagation()
          }
        }}
        onPointerDown={() => {
          gestureRef.current += 1
        }}
        step={1}
        type="range"
        value={percent}
      />
      <output className="film-volume-value" htmlFor={id}>
        {percent}%
      </output>
    </div>
  )
}

type Props = {
  segmentLabel: string | undefined
  sourceVolume: number
  musicVolume: number
  sourceDisabled: boolean
  musicDisabled: boolean
  alignmentBlocked: string | undefined
  onSourceVolume: VolumeControlProps['onChange']
  onMusicVolume: VolumeControlProps['onChange']
  onAlign: () => void
}

export function FilmSoundControls({
  segmentLabel,
  sourceVolume,
  musicVolume,
  sourceDisabled,
  musicDisabled,
  alignmentBlocked,
  onSourceVolume,
  onMusicVolume,
  onAlign,
}: Props) {
  return (
    <div aria-label="整片声音" className="film-sound-controls" role="group">
      <span className="film-sound-selection">
        {segmentLabel === undefined ? '选择片段可调原声' : `当前片段 · ${segmentLabel}`}
      </span>
      <VolumeControl
        key={segmentLabel}
        disabled={sourceDisabled}
        label="原声音量"
        onChange={onSourceVolume}
        volume={sourceVolume}
      />
      <VolumeControl
        disabled={musicDisabled}
        label="配乐音量"
        onChange={onMusicVolume}
        volume={musicVolume}
      />
      <BlockedReason reason={alignmentBlocked}>
        <Button
          className="film-sound-align"
          aria-disabled={alignmentBlocked !== undefined ? true : undefined}
          onClick={() => {
            if (alignmentBlocked === undefined) onAlign()
          }}
          size="md"
          variant="outlined"
        >
          自动对齐
        </Button>
      </BlockedReason>
    </div>
  )
}
