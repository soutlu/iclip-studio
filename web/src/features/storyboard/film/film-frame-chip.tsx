/** 制作页正文里 `@ImageN` 那枚芯片：N 是这组参考图列表里的编号（`frame.number`），画成 `FilmImageChip`。芯片渲染在编辑核心的 portal 里，
 * 这组的图、哪枚高亮与点了做什么经 context 现取（每段一个），编辑器不用因为它们重建。节点见 `film-frame-node`。 */

import { createContext, use, type ReactNode } from 'react'
import type { FilmFrame } from './film.api'
import { frameTag } from './film-content'
import { FilmImageChip } from './film-image-chip'

type FilmFrameChips = {
  frames: readonly FilmFrame[]
  /** 实色高亮的那一张在 `frames` 里的位置；这段没选中、或舞台没在看这段的图时为 undefined。 */
  highlighted: number | undefined
  /** 点了 `frames` 里第 `position` 张：舞台看它。 */
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
  // 按编号找，不按下标：`frames` 末尾还接着没进列表、没有编号的机位图。
  const index = chips?.frames.findIndex((item) => item.number === n) ?? -1
  const frame = chips?.frames[index]
  // 这组没有的编号（手打的、删图后没对上的）照样画成一格空位，不能点；保存时由后端检查拒绝。
  if (chips === null || frame === undefined)
    return <FilmImageChip label={`@${n}`} onEnlarge={() => {}} tag={`@${n}`} url={null} />
  const position = index + 1
  return (
    <FilmImageChip
      highlighted={chips.highlighted === position}
      label={frame.label}
      onEnlarge={(url) => chips.onEnlarge({ name: frame.label, url })}
      onPick={() => chips.onPick(position)}
      tag={frameTag(frame)}
      url={frame.url}
    />
  )
}
