import type { ReactNode } from 'react'
import { DuoGlyph, type GlyphProps } from './duo-glyph'

const FILL = 'final-cut-glyph-fill'

const glyph = (body: ReactNode) =>
  function FileGlyph(props: GlyphProps) {
    return <DuoGlyph {...props}>{body}</DuoGlyph>
  }

/** 工作区文件目录树的双色图标：文档（Markdown、纯文本）、代码、JSON、目录。 */
export const FILE_GLYPHS = {
  'file-doc': glyph(
    <>
      <path
        className={FILL}
        d="M5.5 4.5h8.5l4.5 4.5v10.5a1.8 1.8 0 0 1-1.8 1.8H7.3a1.8 1.8 0 0 1-1.8-1.8V4.5Z"
      />
      <path d="M14 3.75H7a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.75l-5-5Z" />
      <path d="M14 3.75v5h5M8.5 13h7M8.5 16.25h4.5" />
    </>,
  ),
  'file-code': glyph(
    <>
      <rect className={FILL} height={15} rx={3} width={17} x={3.5} y={4.5} />
      <rect height={15.5} rx={3.2} width={17.5} x={3.25} y={4.25} />
      <path d="m9.5 9.5-2.5 2.5 2.5 2.5M14.5 9.5l2.5 2.5-2.5 2.5" />
    </>,
  ),
  'file-data': glyph(
    <>
      <rect className={FILL} height={15} rx={3} width={16} x={4} y={4.5} />
      <path d="M8.5 6.5c-1.4 0-2 .6-2 2v1.8c0 1-.6 1.7-1.5 1.7.9 0 1.5.7 1.5 1.7v1.8c0 1.4.6 2 2 2M15.5 6.5c1.4 0 2 .6 2 2v1.8c0 1 .6 1.7 1.5 1.7-.9 0-1.5.7-1.5 1.7v1.8c0 1.4-.6 2-2 2" />
    </>,
  ),
  'file-folder': glyph(
    <>
      <path
        className={FILL}
        d="M3.5 8.5h17v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V8.5Z"
      />
      <path d="M3 7.2a2.2 2.2 0 0 1 2.2-2.2h4.1l2 2.2h7.5A2.2 2.2 0 0 1 21 9.4v7.9a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.3V7.2Z" />
    </>,
  ),
} as const
