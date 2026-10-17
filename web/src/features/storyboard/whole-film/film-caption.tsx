import type { CSSProperties } from 'react'
import type { CaptionPresentation } from './caption-layout'

const presentationStyle = (presentation: CaptionPresentation): CSSProperties => {
  const scaled = (value: number) => `${(value / presentation.frame.width) * 100}cqw`
  return {
    fontFamily: presentation.fontFamily,
    fontWeight: presentation.fontWeight,
    fontStyle: presentation.fontStyle,
    fontSynthesis: 'none',
    fontKerning: 'normal',
    fontSize: scaled(presentation.fontSize),
    lineHeight: scaled(presentation.lineHeight),
    left: scaled(presentation.marginSide),
    right: scaled(presentation.marginSide),
    bottom: scaled(presentation.marginBottom),
    WebkitTextStroke: `${scaled(presentation.outline * 2)} var(--color-scrim)`,
    paintOrder: 'stroke fill',
    textShadow: 'none',
    whiteSpace: 'pre',
    letterSpacing: 0,
    wordSpacing: 0,
  }
}

export function FilmCaption({
  text,
  presentation,
}: {
  text: string
  presentation: CaptionPresentation | undefined
}) {
  if (text.trim() === '') return null
  return (
    <p
      className="film-preview-caption"
      data-testid="preview-caption"
      style={presentation === undefined ? undefined : presentationStyle(presentation)}
    >
      {text}
    </p>
  )
}
