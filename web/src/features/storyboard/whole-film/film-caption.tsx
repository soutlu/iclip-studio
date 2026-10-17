import type { CSSProperties } from 'react'
import type { CaptionPresentation } from './caption-layout'

const presentationStyle = (presentation: CaptionPresentation): CSSProperties => {
  const scaled = (value: number) => `${(value / presentation.frame.width) * 100}cqw`
  const layout: CSSProperties = {
    fontSize: scaled(presentation.fontSize),
    lineHeight: scaled(presentation.lineHeight),
    left: scaled(presentation.marginSide),
    right: scaled(presentation.marginSide),
    bottom: scaled(presentation.marginBottom),
    whiteSpace: 'pre',
  }
  const { font } = presentation
  if (font === null) return layout
  return {
    ...layout,
    fontFamily: font.fontFamily,
    fontWeight: font.fontWeight,
    fontStyle: font.fontStyle,
    fontSynthesis: 'none',
    fontKerning: 'normal',
    WebkitTextStroke: `${scaled(presentation.outline * 2)} var(--color-scrim)`,
    paintOrder: 'stroke fill',
    textShadow: 'none',
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
