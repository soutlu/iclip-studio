import { createContext, use, type ReactNode } from 'react'

type FrameChips = {
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
      aria-label={`查看第 ${n} 帧`}
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
      <span className="frame-chip-pill ui-motion-s">
        <img alt="" hidden={url === undefined} src={url} />
        <span>@{n}</span>
      </span>
    </span>
  )
}
