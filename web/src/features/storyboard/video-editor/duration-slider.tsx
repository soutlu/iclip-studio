import { Slider } from 'radix-ui'
import './duration-slider.css'

type DurationSliderProps = {
  min: number
  max: number
  seconds: number
  disabled: boolean
  onChange: (seconds: number) => void
}

export function DurationSlider({ min, max, seconds, disabled, onChange }: DurationSliderProps) {
  return (
    <div className="video-editor-duration">
      <Slider.Root
        className="video-editor-duration-slider"
        disabled={disabled}
        min={min}
        max={max}
        step={1}
        value={[seconds]}
        onValueChange={([value]) => {
          if (value !== undefined) onChange(value)
        }}
      >
        <Slider.Track className="video-editor-duration-track">
          <Slider.Range className="video-editor-duration-range" />
        </Slider.Track>
        <Slider.Thumb
          aria-label="生成时长（秒）"
          aria-valuetext={`${seconds} 秒`}
          className="video-editor-duration-thumb ui-focus"
        />
      </Slider.Root>
      <output aria-label="当前生成时长" className="video-editor-duration-value">
        {seconds}
        <span>秒</span>
      </output>
    </div>
  )
}
