import { Icon } from '@/shared/icons'
import type { SecondsRange } from './clip'

type StageLabelProps = {
  /** 放的是什么，如「原片 · 镜头 4–5」「素材 · 镜头组 1 · 生成 B · 镜头 2」。 */
  label: string
  /** 正放到的时刻与选区，都按这条视频自己的时间（秒）。 */
  time: number
  range: SecondsRange
}

const seconds = (value: number) => value.toFixed(1)

/** 舞台左上角注明放的是哪条视频的哪一段：成片页预览素材、编辑视频预览原片时盖在舞台上。 */
export function StageLabel({ label, time, range }: StageLabelProps) {
  return (
    <p className="editor-stage-label">
      <Icon decorative name="video" size="xs" />
      {label}
      <span>
        {seconds(time)} 秒 · 选区 {seconds(range.start)}–{seconds(range.end)}
      </span>
    </p>
  )
}
