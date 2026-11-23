import type { ReactNode } from 'react'
import { DuoGlyph, type GlyphProps } from './duo-glyph'

// 垫淡填充的那层：颜色和浓淡由调用处的 CSS 变量决定，好让导航、轨道头按媒体种类着色
const FILL = 'final-cut-glyph-fill'
// 细线：刻度、副线这类不该和主描边抢的笔画
const THIN = 1.4

const glyph = (body: ReactNode) =>
  function FinalCutGlyph(props: GlyphProps) {
    return <DuoGlyph {...props}>{body}</DuoGlyph>
  }

const STAR = 'M11.5 3.5 13.7 9.3l5.8 2.2-5.8 2.2-2.2 5.8-2.2-5.8-5.8-2.2 5.8-2.2 2.2-5.8Z'

const SPEAKER =
  'M11 5.6 6.4 9.2H3.6a1.1 1.1 0 0 0-1.1 1.1v3.4a1.1 1.1 0 0 0 1.1 1.1h2.8L11 18.4V5.6Z'
const EYE = 'M2.6 12s3.4-6 9.4-6 9.4 6 9.4 6-3.4 6-9.4 6-9.4-6-9.4-6Z'
const NOTE_STEM = 'M10.3 17.2V6.6l7.2-1.8v4.8'
const TRAY = 'M4.5 16h15v2.2a2.3 2.3 0 0 1-2.3 2.3H6.8a2.3 2.3 0 0 1-2.3-2.3V16Z'
const PANEL_SIDE = 'M15 4.25h3.25a3 3 0 0 1 3 3v9.5a3 3 0 0 1-3 3H15V4.25Z'
const CLOUD =
  'M7.2 18.5h10.2a4.1 4.1 0 0 0 .7-8.14A5.75 5.75 0 0 0 6.8 9.2 4.65 4.65 0 0 0 7.2 18.5Z'
const TRAY_EDGE = 'M4.2 15.8v2.4a2.3 2.3 0 0 0 2.3 2.3h11a2.3 2.3 0 0 0 2.3-2.3v-2.4'
const MIC = (
  <>
    <rect className={FILL} height={10.8} rx={3.4} width={6.8} x={8.6} y={3.2} />
    <rect height={10.8} rx={3.4} width={6.8} x={8.6} y={3.2} />
    <path d="M5.4 11a6.6 6.6 0 0 0 13.2 0M12 17.6v3.1M8.8 20.7h6.4" />
  </>
)

/** 按语义名登记进 `@/shared/icons` 的 final-cut 图标。 */
export const FINAL_CUT_GLYPHS = {
  // 侧栏导航与轨道头：镜头（也是画面轨）、贴片、场景、配乐、字幕、属性
  'final-cut-shots': glyph(
    <>
      <rect className={FILL} height={15} rx={1.2} width={11} x={6.5} y={4.5} />
      <rect height={15.5} rx={3.2} width={18.5} x={2.75} y={4.25} />
      <path d="M6.75 4.25v15.5M17.25 4.25v15.5" />
      <path
        d="M3 8.75h3.5M3 12h3.5M3 15.25h3.5M17.5 8.75H21M17.5 12H21M17.5 15.25H21"
        strokeWidth={THIN}
      />
      <path
        d="M10.8 9.85c0-.58.64-.93 1.13-.62l3.35 2.15c.45.29.45.95 0 1.24l-3.35 2.15c-.49.31-1.13-.04-1.13-.62v-4.3Z"
        fill="currentColor"
        opacity={0.75}
        stroke="none"
      />
    </>,
  ),
  'final-cut-overlays': glyph(
    <>
      <rect className={FILL} height={12.5} rx={3} width={14.5} x={3.5} y={4.5} />
      <rect height={13} rx={3.2} width={15} x={3.25} y={4.25} />
      <path d="M8.5 17.25v.5A2.75 2.75 0 0 0 11.25 20.5h7A2.75 2.75 0 0 0 21 17.75v-6.5A2.75 2.75 0 0 0 18.25 8.5" />
      <path d="M6.75 11.5h5.2M6.75 14.25h8" />
      <circle cx={7.2} cy={8} fill="currentColor" r={1.15} stroke="none" />
    </>,
  ),
  'final-cut-scenes': glyph(
    <>
      <rect className={FILL} height={13} rx={3.2} width={18} x={3} y={5.5} />
      <rect height={13.5} rx={3.5} width={18.5} x={2.75} y={5.25} />
      <path d="M9.6 9.35c0-.66.73-1.06 1.29-.71l4.2 2.65c.52.33.52 1.09 0 1.42l-4.2 2.65c-.56.35-1.29-.05-1.29-.71v-5.3Z" />
      <path
        d="M17.6 7.4l.42 1.18 1.18.42-1.18.42-.42 1.18-.42-1.18L16 9l1.18-.42.42-1.18Z"
        fill="currentColor"
        opacity={0.85}
        stroke="none"
      />
    </>,
  ),
  'final-cut-music': glyph(
    <>
      <circle className={FILL} cx={7.25} cy={17.25} r={3} />
      <circle className={FILL} cx={17.75} cy={15.25} r={3} />
      <path className={FILL} d="M10.25 6.4 20.75 4.2v3.3l-10.5 2.2Z" />
      <path d="M10.25 17.25V6.3c0-.72.51-1.34 1.22-1.48l7.8-1.56c.82-.16 1.58.46 1.58 1.3v10.69" />
      <path d="M10.25 9.6 20.85 7.4" strokeWidth={THIN} />
      <circle cx={7.25} cy={17.25} r={3} />
      <circle cx={17.85} cy={15.25} r={3} />
    </>,
  ),
  'final-cut-captions': glyph(
    <>
      <rect className={FILL} height={14} rx={3.5} width={18} x={3} y={5} />
      <rect height={14.5} rx={3.6} width={18.5} x={2.75} y={4.75} />
      <path d="M6.75 12.25h4.2M13.5 12.25h3.75M6.75 15.5h6.6M15.8 15.5h1.45" />
      <circle cx={7.4} cy={8.5} fill="currentColor" opacity={0.75} r={1.05} stroke="none" />
    </>,
  ),
  'final-cut-properties': glyph(
    <>
      <circle className={FILL} cx={9} cy={7.5} r={2.7} />
      <circle className={FILL} cx={15} cy={16.5} r={2.7} />
      <path d="M3.5 7.5h2.8M11.7 7.5h8.8M3.5 16.5h8.8M17.7 16.5h2.8" />
      <circle cx={9} cy={7.5} r={2.65} />
      <circle cx={15} cy={16.5} r={2.65} />
    </>,
  ),
  // 人声轨的轨道头、「识别字幕」、「纯净人声」预设
  'final-cut-voice': glyph(MIC),

  // 通用操作
  'final-cut-search': glyph(
    <>
      <circle className={FILL} cx={10.8} cy={10.8} r={6.6} />
      <circle cx={10.8} cy={10.8} r={6.7} />
      <path d="m15.7 15.7 4.5 4.5" />
    </>,
  ),
  'final-cut-close': glyph(<path d="M17.5 6.5 6.5 17.5M6.5 6.5l11 11" />),
  'final-cut-add': glyph(<path d="M12 5.2v13.6M5.2 12h13.6" />),
  'final-cut-expand': glyph(<path d="m6.5 9.2 5.5 5.6 5.5-5.6" />),
  // 「属性」面板未选中片段时的空态指引图标
  'final-cut-cursor-select': glyph(
    <>
      <rect className={FILL} height={9} rx={2.4} width={14} x={3.5} y={5.5} />
      <path d="M10.5 14.5H6a2.5 2.5 0 0 1-2.5-2.5V8A2.5 2.5 0 0 1 6 5.5h9A2.5 2.5 0 0 1 17.5 8v2.5" />
      <path d="m13.5 12.5 2.4 7.3 1.4-2.8 2.9-1.3-6.7-3.2Z" />
    </>,
  ),
  // 画面上的参考线（构图网格、安全区）
  'final-cut-guides': glyph(
    <>
      <path d="M3.75 8.7h16.5M3.75 15.3h16.5M8.7 3.75v16.5M15.3 3.75v16.5" strokeWidth={THIN} />
      <rect height={17.4} rx={3.3} width={17.4} x={3.3} y={3.3} />
    </>,
  ),
  // 互换宽高
  'final-cut-swap': glyph(<path d="M4.8 9h14.4l-3.45-3.45M19.2 15H4.8l3.45 3.45" />),
  'final-cut-disclosure': glyph(<path d="m9.2 6.5 5.6 5.5-5.6 5.5" />),
  'final-cut-more': glyph(
    <g fill="currentColor" stroke="none">
      <circle cx={6} cy={12} r={1.65} />
      <circle cx={12} cy={12} r={1.65} />
      <circle cx={18} cy={12} r={1.65} />
    </g>,
  ),
  'final-cut-delete': glyph(
    <>
      <path
        className={FILL}
        d="M6.4 7.5h11.2l-.9 11.8a2 2 0 0 1-2 1.85H9.3a2 2 0 0 1-2-1.85L6.4 7.5Z"
      />
      <path d="M4 7.2h16M9.2 7.2V5.3a1.5 1.5 0 0 1 1.5-1.5h2.6a1.5 1.5 0 0 1 1.5 1.5v1.9" />
      <path d="M6.5 7.2l.85 11.9a2 2 0 0 0 2 1.85h5.3a2 2 0 0 0 2-1.85l.85-11.9" />
      <path d="M10.2 11.4v5.2M13.8 11.4v5.2" strokeWidth={THIN} />
    </>,
  ),
  'final-cut-upload': glyph(
    <>
      <path className={FILL} d={TRAY} />
      <path d="M12 15.2V4m0 0L8.2 7.8M12 4l3.8 3.8" />
      <path d={TRAY_EDGE} />
    </>,
  ),
  'final-cut-export': glyph(
    <>
      <path className={FILL} d={TRAY} />
      <path d="M12 3.8v11.4m0 0-3.8-3.8M12 15.2l3.8-3.8" />
      <path d={TRAY_EDGE} />
    </>,
  ),
  'final-cut-duration': glyph(
    <>
      <circle className={FILL} cx={12} cy={12} r={8.5} />
      <circle cx={12} cy={12} r={8.6} />
      <path d="M12 7.4v4.8l3.2 2" />
    </>,
  ),
  // 右栏收起成图标轨 / 展开
  'final-cut-panel-close': glyph(
    <>
      <path className={FILL} d={PANEL_SIDE} />
      <rect height={15.5} rx={3.2} width={18.5} x={2.75} y={4.25} />
      <path d="M14.75 4.25v15.5" />
      <path d="m8.2 9.5 2.5 2.5-2.5 2.5" />
    </>,
  ),
  'final-cut-panel-open': glyph(
    <>
      <path className={FILL} d={PANEL_SIDE} />
      <rect height={15.5} rx={3.2} width={18.5} x={2.75} y={4.25} />
      <path d="M14.75 4.25v15.5" />
      <path d="m10.7 9.5-2.5 2.5 2.5 2.5" />
    </>,
  ),
  // 工作台顶栏：已自动保存
  'final-cut-saved': glyph(
    <>
      <path className={FILL} d={CLOUD} />
      <path d={CLOUD} />
      <path d="m9.5 13.6 1.85 1.85 3.65-3.8" />
    </>,
  ),
  // 「配乐」页签里 final-cut 正用着的那条音频
  'final-cut-in-use': glyph(<path d="m5.2 12.6 4.4 4.4 9.2-9.6" />),

  // 播放控制
  'final-cut-play': glyph(
    <path
      d="M7.5 5.4c0-1.08 1.18-1.74 2.1-1.18l9.8 5.95c.88.54.88 1.82 0 2.36l-9.8 5.95c-.92.56-2.1-.1-2.1-1.18V5.4Z"
      fill="currentColor"
      stroke="none"
    />,
  ),
  'final-cut-pause': glyph(
    <g fill="currentColor" stroke="none">
      <rect height={14.4} rx={1.6} width={4.4} x={6} y={4.8} />
      <rect height={14.4} rx={1.6} width={4.4} x={13.6} y={4.8} />
    </g>,
  ),
  'final-cut-sound-on': glyph(
    <>
      <path className={FILL} d={SPEAKER} />
      <path d={SPEAKER} />
      <path d="M15.2 8.9a4.6 4.6 0 0 1 0 6.2M18.2 6.2a8.4 8.4 0 0 1 0 11.6" />
    </>,
  ),
  'final-cut-sound-off': glyph(
    <>
      <path className={FILL} d={SPEAKER} />
      <path d={SPEAKER} />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>,
  ),
  'final-cut-loop': glyph(
    <path d="m16.8 3.6 3.2 3.1-3.2 3.1M4 11.5v-.9A3.9 3.9 0 0 1 7.9 6.7H20M7.2 20.4 4 17.3l3.2-3.1M20 12.5v.9a3.9 3.9 0 0 1-3.9 3.9H4" />,
  ),
  'final-cut-fullscreen': glyph(
    <path d="M8.5 3.75H5.75a2 2 0 0 0-2 2V8.5M15.5 3.75h2.75a2 2 0 0 1 2 2V8.5M15.5 20.25h2.75a2 2 0 0 0 2-2V15.5M8.5 20.25H5.75a2 2 0 0 1-2-2V15.5" />,
  ),
  'final-cut-visible': glyph(
    <>
      <path className={FILL} d={EYE} />
      <path d={EYE} />
      <circle cx={12} cy={12} r={2.6} />
    </>,
  ),
  'final-cut-hidden': glyph(
    <>
      <path className={FILL} d={EYE} />
      <path d="M10.2 6.2A9.8 9.8 0 0 1 12 6c6 0 9.4 6 9.4 6a16.5 16.5 0 0 1-3 3.7M6.3 7.5A15.6 15.6 0 0 0 2.6 12s3.4 6 9.4 6c1.5 0 2.9-.3 4.1-.9" />
      <path d="m3.5 3.5 17 17" />
    </>,
  ),

  // 剪辑工具条
  'final-cut-undo': glyph(<path d="M8.2 12.6 4 8.5l4.2-4.1M4.5 8.5h9.2a5.5 5.5 0 0 1 0 11H9.5" />),
  'final-cut-redo': glyph(
    <path d="M15.8 12.6 20 8.5l-4.2-4.1M19.5 8.5h-9.2a5.5 5.5 0 0 0 0 11h4.2" />,
  ),
  'final-cut-select': glyph(
    <>
      <path className={FILL} d="m5.5 4.2 5.6 15.6 2.5-5.4 5.6-2.4L5.5 4.2Z" />
      <path d="m5.5 4.2 5.6 15.6 2.5-5.4 5.6-2.4L5.5 4.2Z" />
    </>,
  ),
  'final-cut-split': glyph(
    <>
      <circle className={FILL} cx={6.5} cy={6.8} r={2.8} />
      <circle className={FILL} cx={6.5} cy={17.2} r={2.8} />
      <circle cx={6.5} cy={6.8} r={2.8} />
      <circle cx={6.5} cy={17.2} r={2.8} />
      <path d="M19.8 5.2 8.7 15.4M14.2 13.7l5.6 5.1M8.7 8.6l3.4 3.1" />
    </>,
  ),
  'final-cut-detach-audio': glyph(
    <>
      <circle className={FILL} cx={7.5} cy={17.2} r={2.8} />
      <path d={NOTE_STEM} />
      <circle cx={7.5} cy={17.2} r={2.8} />
      <path d="M17.5 13v6.2m0 0-2.4-2.4m2.4 2.4 2.4-2.4" />
    </>,
  ),
  'final-cut-merge-audio': glyph(
    <>
      <circle className={FILL} cx={7.5} cy={17.2} r={2.8} />
      <path d={NOTE_STEM} />
      <circle cx={7.5} cy={17.2} r={2.8} />
      <path d="M17.5 19.2V13m0 0-2.4 2.4m2.4-2.4 2.4 2.4" />
    </>,
  ),
  'final-cut-snap': glyph(
    <>
      <path
        className={FILL}
        d="m6.5 14.8-2.8-2.8 6.9-6.9a6.8 6.8 0 0 1 9.6 9.6l-6.9 6.9-2.8-2.8 6.5-6.5a2.6 2.6 0 0 0-3.7-3.7l-6.8 6.2Z"
      />
      <path d="m6.5 14.8-2.8-2.8 6.9-6.9a6.8 6.8 0 0 1 9.6 9.6l-6.9 6.9-2.8-2.8 6.5-6.5a2.6 2.6 0 0 0-3.7-3.7l-6.8 6.2Z" />
      <path d="m6.1 9.6 2.8 2.8M11.7 15.2l2.8 2.8" strokeWidth={THIN} />
    </>,
  ),
  'final-cut-ripple': glyph(
    <>
      <rect className={FILL} height={11.6} rx={2} width={6.2} x={2.8} y={6.2} />
      <rect className={FILL} height={11.6} rx={2} width={6.2} x={15} y={6.2} />
      <path d="M12 3.8v16.4" />
      <path d="M3.2 12h5.4m0 0-2.1-2.1M8.6 12l-2.1 2.1M20.8 12h-5.4m0 0 2.1-2.1M15.4 12l2.1 2.1" />
    </>,
  ),
  'final-cut-fit': glyph(
    <path d="M3.5 5.5v13M20.5 5.5v13M6.8 12h10.4M9.5 9.2 6.8 12l2.7 2.8M14.5 9.2 17.2 12l-2.7 2.8" />,
  ),

  // 配乐、字幕与属性里的领域动作
  'final-cut-generate': glyph(
    <>
      <path className={FILL} d={STAR} />
      <path d={STAR} />
      <path
        d="M18.6 4.2l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55.55-1.45Z"
        fill="currentColor"
        stroke="none"
      />
    </>,
  ),
  'final-cut-narration': glyph(
    <>
      <rect className={FILL} height={16} rx={1.6} width={3.2} x={10.4} y={4} />
      <path d="M4 10.2v3.6M8 7.5v9M12 4.5v15M16 7.5v9M20 10.2v3.6" />
    </>,
  ),
  'final-cut-translate': glyph(
    <>
      <rect className={FILL} height={10} rx={2.5} width={11} x={3} y={4} />
      <path d="M4.2 6h8.6M8.5 4.2V6M11 6c-.5 3.1-2.7 5.5-5.6 6.7M6.4 8.6c.9 1.6 2.3 2.9 4.2 3.8" />
      <path d="m13.4 20 3.3-8.2L20 20M14.6 17.4h4.2" />
    </>,
  ),
  // 贴片文字「随语言」/「固定」
  'final-cut-follow-locale': glyph(
    <>
      <circle className={FILL} cx={12} cy={12} r={8.5} />
      <circle cx={12} cy={12} r={8.6} />
      <ellipse cx={12} cy={12} rx={3.8} ry={8.5} strokeWidth={THIN} />
      <path d="M3.8 9.2h16.4M3.8 14.8h16.4" strokeWidth={THIN} />
    </>,
  ),
  'final-cut-fixed': glyph(
    <>
      <rect className={FILL} height={9.4} rx={2.6} width={13.6} x={5.2} y={10.8} />
      <rect height={9.4} rx={2.6} width={13.6} x={5.2} y={10.8} />
      <path d="M8.4 10.8V7.6a3.6 3.6 0 0 1 7.2 0v3.2" />
      <circle cx={12} cy={15.4} fill="currentColor" r={1.2} stroke="none" />
    </>,
  ),
  'final-cut-font': glyph(
    <>
      <rect className={FILL} height={15} rx={3} width={17} x={3.5} y={4.5} />
      <path d="M5.2 7.4V5.5h13.6v1.9M12 5.5v13M8.8 18.5h6.4" />
    </>,
  ),
  'final-cut-color': glyph(
    <>
      <path
        className={FILL}
        d="M12 3.5a8.5 8.5 0 0 0 0 17h1.4a2.2 2.2 0 0 0 1.6-3.7 1.8 1.8 0 0 1 1.3-3h1.6A4.1 4.1 0 0 0 20.5 10 8.5 8.5 0 0 0 12 3.5Z"
      />
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17h1.4a2.2 2.2 0 0 0 1.6-3.7 1.8 1.8 0 0 1 1.3-3h1.6A4.1 4.1 0 0 0 20.5 10 8.5 8.5 0 0 0 12 3.5Z" />
      <g fill="currentColor" stroke="none">
        <circle cx={8.4} cy={10.6} r={1.15} />
        <circle cx={11.6} cy={7.8} r={1.15} />
        <circle cx={15.4} cy={9.2} r={1.15} />
      </g>
    </>,
  ),
  // 「精细调音」的全部归零
  'final-cut-reset': glyph(<path d="M4.4 12a7.6 7.6 0 1 0 2.3-5.4L4.4 8.8M4.4 4.4v4.4h4.4" />),
  // 分离出的原声「定位画面」
  'final-cut-locate': glyph(
    <>
      <circle className={FILL} cx={12} cy={12} r={6.2} />
      <circle cx={12} cy={12} r={6.4} />
      <circle cx={12} cy={12} fill="currentColor" r={1.9} stroke="none" />
      <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6" />
    </>,
  ),
  // 配乐片段上「有人说话时自动压低」开着的标记
  'final-cut-duck': glyph(
    <>
      <path className={FILL} d="M3 8h3.5l2.8 7.5h5.4L17.5 8H21v9H3Z" />
      <path d="M2.8 8.2h3.6c1 0 1.6.6 2 1.6l1.3 4.2c.4 1 1 1.6 2 1.6h.6c1 0 1.6-.6 2-1.6l1.3-4.2c.4-1 1-1.6 2-1.6h3.6" />
    </>,
  ),

  // 「音色风格」预设，名字跟预设 id 走；没有专门图形的预设由调用处决定用什么
  'final-cut-preset-original': glyph(
    <>
      <path className={FILL} d="M3 12c2.5 0 3.5-6 5.5-6s3 12 5 12 3.5-6 5.5-6v7H3Z" />
      <path d="M3 12h2.5l2-5.5 3.2 11 2.8-8.5 2 3H21" />
    </>,
  ),
  'final-cut-preset-lofi-tape': glyph(
    <>
      <rect className={FILL} height={12.8} rx={3} width={18.4} x={2.8} y={5.6} />
      <rect height={12.8} rx={3} width={18.4} x={2.8} y={5.6} />
      <circle cx={8.3} cy={12} r={2.2} />
      <circle cx={15.7} cy={12} r={2.2} />
      <path d="M8.3 14.2h7.4" strokeWidth={THIN} />
    </>,
  ),
  'final-cut-preset-room-natural': glyph(
    <>
      <path
        className={FILL}
        d="M3.5 11.2 12 4.5l8.5 6.7v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-7.3Z"
      />
      <path d="M3.5 11.2 12 4.5l8.5 6.7v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-7.3Z" />
      <path d="M9.2 14.8a3.8 3.8 0 0 1 5.6 0" strokeWidth={THIN} />
    </>,
  ),
  'final-cut-preset-room-tight': glyph(
    <>
      <rect className={FILL} height={9} rx={2} width={9} x={7.5} y={7.5} />
      <rect height={17} rx={3.4} width={17} x={3.5} y={3.5} />
      <rect height={8.4} rx={1.8} strokeWidth={THIN} width={8.4} x={7.8} y={7.8} />
    </>,
  ),
  'final-cut-preset-rumble-cut': glyph(
    <>
      <path className={FILL} d={STAR} />
      <path d={STAR} />
    </>,
  ),
  'final-cut-preset-harsh-tame': glyph(
    <>
      <path className={FILL} d="M3 16.5c4.2 0 4.5-9 9-9s4.8 9 9 9v3H3Z" />
      <path d="M3 16.5c4.2 0 4.5-9 9-9s4.8 9 9 9" />
    </>,
  ),
  'final-cut-preset-voice-broadcast': glyph(
    <>
      <circle className={FILL} cx={12} cy={12} r={2.8} />
      <circle cx={12} cy={12} r={2.2} />
      <path d="M7.6 8.2a6 6 0 0 0 0 7.6M16.4 8.2a6 6 0 0 1 0 7.6M4.8 5.6a9.6 9.6 0 0 0 0 12.8M19.2 5.6a9.6 9.6 0 0 1 0 12.8" />
    </>,
  ),
  'final-cut-preset-voice-warm': glyph(
    <>
      <circle className={FILL} cx={12} cy={12} r={4.6} />
      <circle cx={12} cy={12} r={4.4} />
      <path d="M12 3.4v2M12 18.6v2M3.4 12h2M18.6 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4" />
    </>,
  ),
  'final-cut-preset-hall': glyph(
    <>
      <path className={FILL} d="M4.5 19.5V11a7.5 7.5 0 0 1 15 0v8.5Z" />
      <path d="M4.5 19.5V11a7.5 7.5 0 0 1 15 0v8.5M9 19.5V13a3 3 0 0 1 6 0v6.5M3 19.5h18" />
    </>,
  ),
  'final-cut-preset-slap-echo': glyph(
    <>
      <circle className={FILL} cx={8.5} cy={12} r={4.2} />
      <circle cx={8.5} cy={12} r={4.2} />
      <path d="M15.4 8.4a5.4 5.4 0 0 1 0 7.2M18.5 6a8.8 8.8 0 0 1 0 12" />
    </>,
  ),
} as const
