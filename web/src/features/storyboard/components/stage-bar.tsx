import type { ReactNode } from 'react'

type StageBarProps = {
  start?: ReactNode
  end: ReactNode
}

export function StageBar({ end, start }: StageBarProps) {
  return (
    <div className="storyboard-stage-bar">
      <div className="storyboard-stage-bar-start">{start}</div>
      <div className="storyboard-stage-bar-end">{end}</div>
    </div>
  )
}
