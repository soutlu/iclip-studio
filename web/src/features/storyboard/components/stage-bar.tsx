/** 叠在舞台顶部的工具条：左边身份与状态，右边操作；只管摆放，内容由帧视图、成片视图各自组合（`FrameStageBar`、`TakeStageBar`）。
 * 条本身不接指针，点空处等于点画面；里面的控件照常可点，常显不靠悬停。版式见 storyboard.css 的「舞台工具条」一节。 */

import type { ReactNode } from 'react'

type StageBarProps = {
  /** 左上：身份与状态，从上往下排。 */
  start?: ReactNode
  /** 右上：操作按钮，从左往右排。 */
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
