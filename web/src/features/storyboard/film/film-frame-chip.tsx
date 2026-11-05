import { createContext, use, type ReactNode } from 'react'
import type { FilmFrame } from './film.api'
import { frameTag } from './film-content'
import { newImageUrl } from './film-draft-text'
import { FilmImageChip } from './film-image-chip'

type FilmFrameChips = {
  frames: readonly FilmFrame[]
  highlighted: number | undefined
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

const NEW_IMAGE_LABEL = '新插入的图片'

export function FilmFrameChip({ n, token }: { n: number; token: string }) {
  const chips = use(FilmFrameChipsContext)
  const added = newImageUrl(token)
  if (added !== undefined)
    return (
      <FilmImageChip
        label={NEW_IMAGE_LABEL}
        onEnlarge={(url) => chips?.onEnlarge({ name: NEW_IMAGE_LABEL, url })}
        tag="新"
        url={added}
      />
    )
  const index = chips?.frames.findIndex((item) => item.number === n) ?? -1
  const frame = chips?.frames[index]
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
