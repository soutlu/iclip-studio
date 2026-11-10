import type { ComponentProps } from 'react'

type ResourceGlyphProps = ComponentProps<'svg'> & {
  size?: number | string
  absoluteStrokeWidth?: boolean
}

// 镂空用 even-odd 子路径而不是 mask：同页多个图标不必各配唯一 id，镂空处直接透出底块颜色。
function ResourceGlyph({
  size = 24,
  strokeWidth: _strokeWidth,
  absoluteStrokeWidth: _absoluteStrokeWidth,
  children,
  ...props
}: ResourceGlyphProps) {
  return (
    <svg width={size} height={size} {...props} viewBox="0 0 24 24" fill="currentColor">
      {children}
    </svg>
  )
}

const rect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - h}a${r} ${r} 0 0 1 ${r} ${-r}Z`

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`

const PLATE = rect(2.8, 4.8, 18.4, 14.4, 3.2)

const FILM = [
  PLATE,
  ...[7, 10.8, 14.6].flatMap((y) => [rect(4.7, y, 2.1, 2.4, 0.6), rect(17.2, y, 2.1, 2.4, 0.6)]),
  'M10.3 9.4v5.2c0 .6.7 1 1.2.7l4.2-2.6c.5-.3.5-1 0-1.4l-4.2-2.6c-.5-.3-1.2.1-1.2.7Z',
].join('')

const PHOTO = [
  PLATE,
  circle(8.3, 9.5, 1.8),
  'M5.2 17.2 9.3 12.7c.4-.5 1.1-.5 1.5 0l1.9 2.1 2.4-3c.4-.6 1.3-.6 1.7 0l2.4 3.3v1.4c0 .4-.3.7-.7.7H5.2Z',
].join('')

const LIST = [
  rect(2.8, 4.3, 18.4, 15.4, 3.2),
  ...[7.3, 10.8, 14.3].map((y) => rect(5.6, y, 2.4, 2.4, 0.7)),
  rect(9.6, 7.7, 8.8, 1.6, 0.8),
  rect(9.6, 11.2, 8.8, 1.6, 0.8),
  rect(9.6, 14.7, 6.2, 1.6, 0.8),
].join('')

const BOT_HEAD = [
  rect(4.2, 7.9, 15.6, 11.6, 3.8),
  rect(8.1, 11.3, 2.2, 3.2, 1.1),
  rect(13.7, 11.3, 2.2, 3.2, 1.1),
  rect(9.6, 16, 4.8, 1.4, 0.7),
].join('')

export function ResourceAgentGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d={BOT_HEAD} fillRule="evenodd" />
      <rect height={4} rx={0.9} width={1.8} x={11.1} y={4.6} />
      <circle cx={12} cy={4.4} r={1.5} />
      <rect height={4.4} rx={0.95} width={1.9} x={1.9} y={11.6} />
      <rect height={4.4} rx={0.95} width={1.9} x={20.2} y={11.6} />
    </ResourceGlyph>
  )
}

export function ResourceSkillGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d="M11.1 6.9C8.9 5.5 6.1 5.2 3.6 6c-.5.2-.8.6-.8 1.1v10.6c0 .7.7 1.2 1.4 1 2.3-.6 4.7-.3 6.9.9V6.9Z" />
      <path d="M12.9 6.9c2.2-1.4 5-1.7 7.5-.9.5.2.8.6.8 1.1v10.6c0 .7-.7 1.2-1.4 1-2.3-.6-4.7-.3-6.9.9V6.9Z" />
    </ResourceGlyph>
  )
}

export function ResourceWorkspaceGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d="M2.8 7.6c0-1.4 1.1-2.5 2.5-2.5h3.6c.7 0 1.3.3 1.8.8l1 1.1h7c1.4 0 2.5 1.1 2.5 2.5v7.4c0 1.4-1.1 2.5-2.5 2.5H5.3c-1.4 0-2.5-1.1-2.5-2.5V7.6Z" />
    </ResourceGlyph>
  )
}

export function ResourceVideoGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d={FILM} fillRule="evenodd" />
    </ResourceGlyph>
  )
}

export function ResourceProjectGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d="M11.1 3.9c.6-.3 1.2-.3 1.8 0l7.5 3.9c.8.4.8 1.5 0 1.9l-7.5 3.9c-.6.3-1.2.3-1.8 0L3.6 9.7c-.8-.4-.8-1.5 0-1.9l7.5-3.9Z" />
      <path
        d="m4.1 12.9 7.9 4 7.9-4M4.1 16.6l7.9 4 7.9-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.9}
      />
    </ResourceGlyph>
  )
}

export function ResourceMcpGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <rect height={6} rx={1.15} width={2.3} x={7.9} y={2.8} />
      <rect height={6} rx={1.15} width={2.3} x={13.8} y={2.8} />
      <path d="M5.2 8.6c0-.6.5-1.1 1.1-1.1h11.4c.6 0 1.1.5 1.1 1.1v2.6c0 3.3-2.3 6-5.4 6.7v2.2c0 .8-.6 1.4-1.4 1.4s-1.4-.6-1.4-1.4v-2.2c-3.1-.7-5.4-3.4-5.4-6.7V8.6Z" />
    </ResourceGlyph>
  )
}

export function ResourceProviderGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d="M7.2 19c-2.5 0-4.6-2-4.6-4.4 0-2 1.4-3.8 3.4-4.3.6-3 3.1-5.2 6.2-5.2 2.7 0 5 1.7 5.9 4.1 2 .4 3.5 2.2 3.5 4.3 0 2.5-2 4.5-4.5 4.5H7.2Z" />
    </ResourceGlyph>
  )
}

export function ResourcePluginGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d="M5.2 6.4h3A2.4 2.4 0 1 1 12.2 6.4h3a2.4 2.4 0 0 1 2.4 2.4V12a2.2 2.2 0 1 1 0 3.6v3.2a2.4 2.4 0 0 1-2.4 2.4H5.2a2.4 2.4 0 0 1-2.4-2.4V8.8a2.4 2.4 0 0 1 2.4-2.4Z" />
    </ResourceGlyph>
  )
}

export function ResourceShotsGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d={LIST} fillRule="evenodd" />
    </ResourceGlyph>
  )
}

export function ResourceUnderstandingGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path
        d="M12 5.6c4 0 7.4 2.3 9.4 5.9.2.3.2.7 0 1-2 3.6-5.4 5.9-9.4 5.9s-7.4-2.3-9.4-5.9a1 1 0 0 1 0-1C4.6 7.9 8 5.6 12 5.6Zm0 2.6a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"
        fillRule="evenodd"
      />
      <circle cx={12} cy={12} r={1.9} />
    </ResourceGlyph>
  )
}

export function ResourceFrameGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d={PHOTO} fillRule="evenodd" />
    </ResourceGlyph>
  )
}
