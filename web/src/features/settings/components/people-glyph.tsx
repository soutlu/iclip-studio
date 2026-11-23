import { DuoGlyph, type GlyphProps } from '@/shared/icons/duo-glyph'

const FILL = 'final-cut-glyph-fill'

/** 「设置 · 用户」头部双色人群图标：前景人物叠加浅色填充，背景人物以半透明描边呈现。 */
export function PeopleGlyph(props: GlyphProps) {
  return (
    <DuoGlyph {...props}>
      <circle className={FILL} cx={9.5} cy={7.5} r={3.5} />
      <path className={FILL} d="M3.5 19.5c0-3.1 2.7-5.2 6-5.2s6 2.1 6 5.2Z" />
      <circle cx={9.5} cy={7.5} r={3.5} />
      <path d="M3.5 19.5c0-3.1 2.7-5.2 6-5.2s6 2.1 6 5.2" />
      <g opacity={0.55} strokeWidth={1.5}>
        <circle cx={16.8} cy={8.5} r={2.5} />
        <path d="M17 14.3c2.1.4 3.5 1.9 3.5 4.2" />
      </g>
    </DuoGlyph>
  )
}
