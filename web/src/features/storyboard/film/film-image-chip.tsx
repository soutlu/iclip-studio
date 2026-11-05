import { useEffect, useState } from 'react'
import { MediaPreviewCard, useHoverPreview } from '@/shared/ui/media-preview'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type FilmImageChipProps = {
  label: string
  tag: string
  url: string | null
  highlighted?: boolean
  note?: string | undefined
  onPick?: (() => void) | undefined
  onEnlarge: (url: string) => void
}

export function FilmImageChip({
  highlighted = false,
  label,
  note,
  onEnlarge,
  onPick,
  tag,
  url,
}: FilmImageChipProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const tip = useHoverPreview()
  const { close, onEnter, onLeave } = tip
  useEffect(() => {
    if (anchor === null || url === null) return undefined
    anchor.addEventListener('mouseenter', onEnter)
    anchor.addEventListener('mouseleave', onLeave)
    return () => {
      anchor.removeEventListener('mouseenter', onEnter)
      anchor.removeEventListener('mouseleave', onLeave)
    }
  }, [anchor, onEnter, onLeave, url])

  const spoken = `${tag === label ? label : `${label} ${tag}`}${note === undefined ? '' : `，${note}`}`
  const named = tag === label ? label : `${tag} ${label}`
  const hint =
    url !== null || (tag === label && note === undefined)
      ? undefined
      : `${named}${note === undefined ? '' : ` · ${note}`}`
  const pill = (
    <span className="frame-chip-pill ui-motion-s">
      {url === null ? <span className="film-chip-empty" /> : <img alt="" src={url} />}
      <span>{tag}</span>
    </span>
  )
  const chip =
    onPick === undefined ? (
      <span aria-label={spoken} className="frame-chip film-chip" ref={setAnchor} role="img">
        {pill}
      </span>
    ) : (
      <button
        aria-label={`在舞台查看${spoken}`}
        className="frame-chip film-chip ui-focus"
        data-highlighted={highlighted ? '' : undefined}
        onClick={onPick}
        onFocus={(event) => event.stopPropagation()}
        ref={setAnchor}
        type="button"
      >
        {pill}
      </button>
    )
  return (
    <>
      {hint === undefined ? (
        chip
      ) : (
        <TooltipRoot>
          <TooltipTrigger asChild>{chip}</TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </TooltipRoot>
      )}
      {tip.open && anchor !== null && url !== null ? (
        <MediaPreviewCard
          anchorEl={anchor}
          media={{ kind: 'image', name: label, previewUrl: url }}
          onEnlarge={() => {
            close()
            onEnlarge(url)
          }}
          onEnter={onEnter}
          onLeave={onLeave}
        />
      ) : null}
    </>
  )
}
