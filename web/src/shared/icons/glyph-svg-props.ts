import type { ComponentProps } from 'react'
import type { GlyphProps } from './duo-glyph'

/** 自绘图标 24×24 `<svg>` 的共用属性：丢掉 lucide 传进来的描边参数，描边由各图标自己定。 */
export const glyphSvgProps = ({
  size = 24,
  strokeWidth: _strokeWidth,
  absoluteStrokeWidth: _absoluteStrokeWidth,
  ...props
}: GlyphProps): ComponentProps<'svg'> => ({
  width: size,
  height: size,
  ...props,
  fill: 'none',
  viewBox: '0 0 24 24',
})
