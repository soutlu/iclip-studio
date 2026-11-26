import type { ReactNode } from 'react'
import type { GlyphProps } from './duo-glyph'
import './audio-cover-glyphs.css'

const SEC = 'audition-glyph-sec'
const SEC_SOFT = 'audition-glyph-sec-soft'
const TONE_FILL = 'audition-glyph-tone-fill'
const TONE_STROKE = 'audition-glyph-tone-stroke'

const coverGlyph = (body: ReactNode) =>
  function AudioCoverGlyph({
    size = 24,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    ...props
  }: GlyphProps) {
    return (
      <svg height={size} width={size} {...props} fill="none" viewBox="0 0 24 24">
        {body}
      </svg>
    )
  }

/**
 * 音频封面（音色 8 款 + 配乐 4 款）专用双层声学图标：基于 24×24 物理像素网格绘制，
 * 副结构统一在 `<g>` 内以 `currentColor` 整组降透，主视觉锚点读取 `--audition-cover-tone`。
 */
export const AUDIO_COVER_GLYPHS = {
  // ── 音色（8 款）────────────────────────────────────────────────────────────
  'audio-cover-bright': coverGlyph(
    <>
      <g className={SEC_SOFT} fill="currentColor">
        <rect height={4} rx={1} width={2} x={3.5} y={10} />
        <rect height={4} rx={1} width={2} x={18.5} y={10} />
      </g>
      <g className={SEC} fill="currentColor">
        <rect height={9} rx={1} width={2} x={7} y={7.5} />
        <rect height={9} rx={1} width={2} x={15} y={7.5} />
      </g>
      <rect className={TONE_FILL} height={16} rx={1.25} width={2.5} x={10.75} y={4} />
    </>,
  ),
  'audio-cover-studio': coverGlyph(
    <>
      <g className={SEC} stroke="currentColor" strokeLinecap="round" strokeWidth={1.85}>
        <path d="M6.5 10.5v.75a5.5 5.5 0 0 0 11 0v-.75M12 16.75v3M9.25 19.75h5.5" />
      </g>
      <rect className={TONE_FILL} height={10} rx={2.75} width={5.5} x={9.25} y={4} />
    </>,
  ),
  'audio-cover-calm': coverGlyph(
    <>
      <g className={SEC_SOFT} stroke="currentColor" strokeLinecap="round" strokeWidth={1.6}>
        <path d="M4.59 6.21a9.4 9.4 0 0 0 0 11.58M19.41 6.21a9.4 9.4 0 0 1 0 11.58" />
      </g>
      <g className={SEC} stroke="currentColor" strokeLinecap="round" strokeWidth={1.85}>
        <path d="M7.85 7.39a6.2 6.2 0 0 0 0 9.22M16.15 7.39a6.2 6.2 0 0 1 0 9.22" />
      </g>
      <circle className={TONE_FILL} cx={12} cy={12} r={2.85} />
    </>,
  ),
  'audio-cover-pulse': coverGlyph(
    <>
      <g className={SEC} stroke="currentColor" strokeLinecap="round" strokeWidth={1.85}>
        <path d="M15.95 4.97a10.5 10.5 0 0 1 0 14.06" />
      </g>
      <circle className={TONE_FILL} cx={8.15} cy={12} r={2.75} />
      <path
        className={TONE_STROKE}
        d="M12.98 7.65a6.5 6.5 0 0 1 0 8.7"
        strokeLinecap="round"
        strokeWidth={2.15}
      />
    </>,
  ),
  'audio-cover-cinema': coverGlyph(
    <>
      <g className={SEC} fill="currentColor">
        <path
          d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17Zm0 1.8a6.7 6.7 0 1 1 0 13.4 6.7 6.7 0 1 1 0-13.4Z"
          fillRule="evenodd"
        />
      </g>
      <path
        className={TONE_FILL}
        d="M12 7.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 1 0 0-9.5Zm0 3.1a1.65 1.65 0 1 1 0 3.3 1.65 1.65 0 1 1 0-3.3Z"
        fillRule="evenodd"
      />
    </>,
  ),
  'audio-cover-broadcast': coverGlyph(
    <>
      <g className={SEC}>
        <rect fill="currentColor" height={5} rx={1.15} width={2.75} x={4.25} y={9.5} />
        <path
          d="M18.1 8.5a5.6 5.6 0 0 1 0 7"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={1.9}
        />
      </g>
      <path
        className={TONE_FILL}
        d="M8.6 10.4c0-.6.35-1.05.9-1.35l4.25-2.9c.8-.55 1.75.03 1.75 1v9.7c0 .97-.95 1.55-1.75 1l-4.25-2.9c-.55-.3-.9-.75-.9-1.35v-3.2Z"
      />
    </>,
  ),
  'audio-cover-dialogue': coverGlyph(
    <>
      <g className={SEC} fill="currentColor">
        <path d="M16.6 9.6h.6a2.6 2.6 0 0 1 2.6 2.6v5.85c0 .55-.45.87-.9.55l-2.5-1.8H12.1a2.6 2.6 0 0 1-2.55-1h2.85a4.2 4.2 0 0 0 4.2-4.2v-2Z" />
      </g>
      <path
        className={TONE_FILL}
        d="M6.8 5h5.6A2.6 2.6 0 0 1 15 7.6v4a2.6 2.6 0 0 1-2.6 2.6H7.6l-2.5 1.8c-.45.32-.9 0-.9-.55V7.6A2.6 2.6 0 0 1 6.8 5Z"
      />
    </>,
  ),
  'audio-cover-tuning': coverGlyph(
    <>
      <g className={SEC} stroke="currentColor" strokeLinecap="round" strokeWidth={1.75}>
        <path d="M5.4 6.2a7.8 7.8 0 0 0 0 5.6M18.6 6.2a7.8 7.8 0 0 1 0 5.6" />
      </g>
      <path
        className={TONE_STROKE}
        d="M8.5 4.75v5.75a3.5 3.5 0 0 0 7 0V4.75M12 14v5.5"
        strokeLinecap="round"
        strokeWidth={2.15}
      />
    </>,
  ),

  // ── 配乐（4 款）────────────────────────────────────────────────────────────
  'audio-cover-piano': coverGlyph(
    <>
      <g className={SEC} stroke="currentColor" strokeLinecap="round">
        <rect height={14} rx={2.5} strokeWidth={1.7} width={15} x={4.5} y={5} />
        <path d="M9.5 14.3V19M14.5 14.3V19" strokeWidth={1.6} />
      </g>
      <rect className={TONE_FILL} height={8.25} rx={1} width={2.8} x={8.1} y={4.15} />
      <rect className={TONE_FILL} height={8.25} rx={1} width={2.8} x={13.1} y={4.15} />
    </>,
  ),
  'audio-cover-acoustic': coverGlyph(
    <>
      <g className={SEC} stroke="currentColor" strokeLinecap="round" strokeWidth={1.8}>
        <path d="M16 13h3.5M14.6 16.6h4.9" />
      </g>
      <ellipse
        className={TONE_FILL}
        cx={8.3}
        cy={16.3}
        rx={2.85}
        ry={2.15}
        transform="rotate(-22 8.3 16.3)"
      />
      <path
        className={TONE_STROKE}
        d="M10.25 15.6V5c2.55.7 4.35 2.3 4.55 4.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </>,
  ),
  'audio-cover-electronic': coverGlyph(
    <>
      <g className={SEC} fill="currentColor">
        <rect height={6.4} rx={1.75} width={6.4} x={13} y={4.6} />
        <rect height={6.4} rx={1.75} width={6.4} x={4.6} y={13} />
      </g>
      <rect className={TONE_FILL} height={6.4} rx={1.75} width={6.4} x={4.6} y={4.6} />
      <rect className={TONE_FILL} height={6.4} rx={1.75} width={6.4} x={13} y={13} />
    </>,
  ),
  'audio-cover-vinyl': coverGlyph(
    <>
      <g className={SEC} fill="currentColor">
        <path
          d="M10.2 6a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 1 0 0-12.4Zm0 3.1a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 1 1 0-6.2Z"
          fillRule="evenodd"
        />
      </g>
      <circle className={TONE_FILL} cx={10.2} cy={12.2} r={1.9} />
      <circle className={TONE_FILL} cx={19} cy={5.9} r={1.35} />
      <path
        className={TONE_STROKE}
        d="M19 5.9v6.4l-1.4 2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.85}
      />
    </>,
  ),
} as const

export type AudioCoverGlyphName = keyof typeof AUDIO_COVER_GLYPHS
