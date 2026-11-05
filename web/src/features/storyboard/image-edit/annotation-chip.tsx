import { createContext, use, type ReactNode } from 'react'
import type { AnnotationNode } from './annotation-node'
import type { ImageAnnotation } from './image-edit-types'

type AnnotationChips = {
  annotations: readonly ImageAnnotation[]
  selectedId: string | null
  onSelect: (id: string) => void
}

const AnnotationChipsContext = createContext<AnnotationChips | null>(null)

export function AnnotationChipsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: AnnotationChips
}) {
  return <AnnotationChipsContext value={value}>{children}</AnnotationChipsContext>
}

export function AnnotationChip({ node }: { node: AnnotationNode }) {
  const chips = use(AnnotationChipsContext)
  const { id, number } = node.attrs
  const live = chips?.annotations.find((annotation) => annotation.id === id)

  if (live === undefined) {
    return (
      <span
        aria-disabled="true"
        className="media-chip attachment-pill annotation-chip annotation-chip-stale"
        title="该标注已在画布上删除"
      >
        <span className="media-chip-icon">
          <span aria-hidden className="annotation-chip-number">
            {number}
          </span>
        </span>
        <span className="media-chip-name">标注 {number} 已删除</span>
      </span>
    )
  }

  const select = () => chips?.onSelect(id)
  return (
    <span
      aria-label={`标注 ${live.number}`}
      className="media-chip attachment-pill annotation-chip"
      data-selected={chips?.selectedId === id ? '' : undefined}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          select()
        }
      }}
      role="button"
      tabIndex={-1}
    >
      <span className="media-chip-icon">
        <span aria-hidden className="annotation-chip-number">
          {live.number}
        </span>
      </span>
      <span className="media-chip-name">标注 {live.number}</span>
    </span>
  )
}
