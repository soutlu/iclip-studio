import type { ReactNode } from 'react'
import { DuoGlyph, type GlyphProps } from './duo-glyph'

const FILL = 'final-cut-glyph-fill'

const glyph = (body: ReactNode) =>
  function ArtifactGlyph(props: GlyphProps) {
    return <DuoGlyph {...props}>{body}</DuoGlyph>
  }

/**
 * 工作台产物的双色图标里图标库原先没有的两个：分镜（四格）、制作（摄像机）。
 * final-cut 用 `final-cut-shots`，文件用 `file-folder`，四个产物同一种画法。
 */
export const ARTIFACT_GLYPHS = {
  'artifact-storyboard': glyph(
    <>
      <rect className={FILL} height={6.5} rx={1.6} width={7} x={3.5} y={4.5} />
      <rect className={FILL} height={6.5} rx={1.6} width={7} x={13.5} y={13} />
      <rect height={6.75} rx={2} width={7.25} x={3.25} y={4.25} />
      <rect height={6.75} rx={2} width={7.25} x={13.5} y={4.25} />
      <rect height={6.75} rx={2} width={7.25} x={3.25} y={13} />
      <rect height={6.75} rx={2} width={7.25} x={13.5} y={13} />
    </>,
  ),
  'artifact-film': glyph(
    <>
      <rect className={FILL} height={11} rx={2.6} width={12.5} x={3} y={6.5} />
      <rect height={11.5} rx={3} width={13} x={2.75} y={6.25} />
      <path d="m15.75 10.4 4.6-2.7a.6.6 0 0 1 .9.52v7.56a.6.6 0 0 1-.9.52l-4.6-2.7" />
    </>,
  ),
} as const
