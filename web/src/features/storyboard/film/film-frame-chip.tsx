/** 制作页正文里 `@ImageN` 那枚芯片：N 是这组 `frames` 里的位置，画成 `FilmImageChip`。芯片渲染在编辑核心的 portal 里，
 * 这组的图、哪枚高亮与点了做什么经 context 现取（每段一个），编辑器不用因为它们重建。节点见 `film-frame-node`。 */

import { createContext, use, type ReactNode } from 'react'
import type { FilmFrame } from './film.api'
import { frameTag } from './film-content'
import { FilmImageChip } from './film-image-chip'

type FilmFrameChips = {
  frames: readonly FilmFrame[]
  /** 实色高亮的那一张的位置；这段没选中、或舞台没在看这段的图时为 undefined。 */
  highlighted: number | undefined
  /** 点第 N 张：舞台看它。 */
  onPick: (position: number) => void
  onEnlarge: (media: { name: string; url: string }) => void
}

const FilmFrameChipsContext = createContext<FilmFrameChips | null>(null)

export function FilmFrameChipsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: FilmFrameChips
}) {
  return <FilmFrameChipsContext value={value}>{children}</FilmFrameChipsContext>
}

export function FilmFrameChip({ n }: { n: number }) {
  const chips = use(FilmFrameChipsContext)
  const frame = chips?.frames[n - 1]
  // 编号超出这组的（手打的、删图后没对上的）照样画成一格空位，不能点；保存时由后端检查拒绝。
  if (chips === null || frame === undefined)
    return <FilmImageChip label={`@${n}`} onEnlarge={() => {}} tag={`@${n}`} url={null} />
  return (
    <FilmImageChip
      highlighted={chips.highlighted === n}
      label={frame.label}
      onEnlarge={(url) => chips.onEnlarge({ name: frame.label, url })}
      onPick={() => chips.onPick(n)}
      tag={frameTag(frame)}
      url={frame.url}
    />
  )
}
