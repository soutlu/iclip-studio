import type { ComponentProps, ReactNode } from 'react'
import './final-cut-glyphs.css'

export type GlyphProps = ComponentProps<'svg'> & {
  size?: number | string
  absoluteStrokeWidth?: boolean
}

/**
 * final-cut 双色图标的画框：24 网格、1.65 圆角描边。图形里要垫淡填充的部分带 `final-cut-glyph-fill` 类
 * （样子见 `final-cut-glyphs.css`）；描边和实心部分用 `currentColor`。
 */
export function DuoGlyph({
  size = 24,
  strokeWidth: _strokeWidth,
  absoluteStrokeWidth: _absoluteStrokeWidth,
  children,
  ...props
}: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      {...props}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.65}
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  )
}
