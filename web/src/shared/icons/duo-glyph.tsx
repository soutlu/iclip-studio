import type { ComponentProps, ReactNode } from 'react'
import { glyphSvgProps } from './glyph-svg-props'
import './final-cut-glyphs.css'

export type GlyphProps = ComponentProps<'svg'> & {
  size?: number | string
  absoluteStrokeWidth?: boolean
}

/**
 * 双色图标容器（供 final-cut、工作区文件树、工作台产物与设置弹窗共用）：采用 24×24 网格与 1.65px 圆角描边。
 * 需叠加浅填充的图形元素附加 `final-cut-glyph-fill` 类（样式见 `final-cut-glyphs.css`）；描边与实心部分统一使用 `currentColor`。
 */
export function DuoGlyph({ children, ...props }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      {...glyphSvgProps(props)}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.65}
    >
      {children}
    </svg>
  )
}
