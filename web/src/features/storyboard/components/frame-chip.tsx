/** 正文里的帧芯片 `@N`：缩略图加编号，舞台正在看的那一帧实色高亮；点击或 Enter / 空格看这一帧。
 * 外观、舞台高亮与聚焦环都在 storyboard.css 的「帧芯片」一节；这里只给结构与状态。
 *
 * 芯片渲染在编辑核心的 portal 里，帧地址、高亮与点击经 context 现取，编辑器不用因为它们重建。 */

import { createContext, use, type ReactNode } from 'react'

type FrameChips = {
  /** 帧数组下标为编号减一。 */
  frames: readonly string[]
  highlighted: number | undefined
  onPick: (n: number) => void
}

const FrameChipsContext = createContext<FrameChips | null>(null)

export function FrameChipsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: FrameChips
}) {
  return <FrameChipsContext value={value}>{children}</FrameChipsContext>
}

export function FrameChip({ n }: { n: number }) {
  const chips = use(FrameChipsContext)
  const url = chips?.frames[n - 1]
  const pick = () => chips?.onPick(n)
  return (
    <span
      aria-label={`看第 ${n} 帧`}
      className="frame-chip cursor-pointer select-none"
      data-highlighted={chips?.highlighted === n ? '' : undefined}
      onClick={(event) => {
        event.preventDefault()
        pick()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        pick()
      }}
      role="button"
      tabIndex={0}
    >
      {/* 外层是普通行内元素，胶囊画在里层：外层尾部的零宽连字符让芯片和紧跟的标点不在中间断行。 */}
      <span className="frame-chip-pill ui-motion-s">
        <img alt="" hidden={url === undefined} src={url} />
        <span>@{n}</span>
      </span>
    </span>
  )
}
