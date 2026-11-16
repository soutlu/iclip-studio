import { Icon } from '@/shared/icons'
import type { SecondsRange } from './clip'

type StageLabelProps = {
  label: string
  time: number
  range: SecondsRange
}

const seconds = (value: number) => value.toFixed(1)

export function StageLabel({ label, time, range }: StageLabelProps) {
  return (
    <p className="editor-stage-label">
      <Icon decorative name="video" size="xs" />
      <span className="editor-stage-label-name">{label}</span>
      <span className="editor-stage-label-time">
        {seconds(time)} 秒 · 选区 {seconds(range.start)}–{seconds(range.end)}
      </span>
    </p>
  )
}
