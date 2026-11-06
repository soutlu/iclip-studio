import type { ComponentProps } from 'react'

type ResourceGlyphProps = ComponentProps<'svg'> & {
  size?: number | string
  absoluteStrokeWidth?: boolean
}

function ResourceGlyph({
  size = 24,
  strokeWidth: _strokeWidth,
  absoluteStrokeWidth: _absoluteStrokeWidth,
  children,
  ...props
}: ResourceGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export function ResourceAgentGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <rect
        x={4.25}
        y={7.25}
        width={15.5}
        height={12.25}
        rx={3.5}
        fill="currentColor"
        fillOpacity={0.14}
      />
      <path d="M12 7.25V3.5M2.25 11.5v4m19.5-4v4M8.5 11.75v1.5m7-1.5v1.5M9.5 16h5" />
    </ResourceGlyph>
  )
}

export function ResourceSkillGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path
        d="M12 6.1c-2.5-1.7-5.4-1.9-8.5-.9v13c3.1-1 6-.8 8.5.9 2.5-1.7 5.4-1.9 8.5-.9v-13c-3.1-1-6-.8-8.5.9Z"
        fill="currentColor"
        fillOpacity={0.12}
      />
      <path d="M12 6.1v13M6.5 9.1c.9-.1 1.8.1 2.6.5m5.8 0c.8-.4 1.7-.6 2.6-.5" />
    </ResourceGlyph>
  )
}

export function ResourceWorkspaceGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d="M3.25 16.75V6.1A1.85 1.85 0 0 1 5.1 4.25h4l2 2h7.8a1.85 1.85 0 0 1 1.85 1.85V9.5" />
      <path
        d="M6.25 9.5H20a1.25 1.25 0 0 1 1.2 1.65l-2.3 6.9a2 2 0 0 1-1.9 1.4H5a1.75 1.75 0 0 1-1.7-2.2L4.8 10.6a1.5 1.5 0 0 1 1.45-1.1Z"
        fill="currentColor"
        fillOpacity={0.16}
      />
    </ResourceGlyph>
  )
}

export function ResourceVideoGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <rect
        x={3.25}
        y={4.25}
        width={17.5}
        height={15.5}
        rx={2.25}
        fill="currentColor"
        fillOpacity={0.12}
      />
      <path d="M3.5 7.5h17M3.5 16.5h17M8 4.5v3m8-3v3M8 16.5v3m8-3v3" />
      <path d="m10.25 9.75 4 2.25-4 2.25Z" fill="currentColor" fillOpacity={0.18} />
    </ResourceGlyph>
  )
}

export function ResourceProjectGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path d="m12 3.75 9 4.5-9 4.5-9-4.5Z" fill="currentColor" fillOpacity={0.16} />
      <path d="m3 12 9 4.5 9-4.5M3 15.75l9 4.5 9-4.5" />
    </ResourceGlyph>
  )
}

export function ResourceMcpGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path
        d="M6.75 7.25h10.5v3.5a5.25 5.25 0 0 1-10.5 0Z"
        fill="currentColor"
        fillOpacity={0.16}
      />
      <path d="M9 7.25v-3.5m6 3.5v-3.5M5.25 7.25h13.5M12 16v1.25a3 3 0 0 1-3 3H7" />
    </ResourceGlyph>
  )
}

export function ResourceProviderGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path
        d="M7 18.75h10.5a4.25 4.25 0 0 0 .5-8.47A6.25 6.25 0 0 0 5.8 9.2 4.8 4.8 0 0 0 7 18.75Z"
        fill="currentColor"
        fillOpacity={0.14}
      />
      <path d="M8.75 15h6.5" />
    </ResourceGlyph>
  )
}

export function ResourcePluginGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path
        d="M4.25 7.25a1.5 1.5 0 0 1 1.5-1.5h3.5a2.75 2.75 0 1 1 5.5 0h3.5a1.5 1.5 0 0 1 1.5 1.5v3.5a2.75 2.75 0 1 0 0 5.5v2a1.5 1.5 0 0 1-1.5 1.5H5.75a1.5 1.5 0 0 1-1.5-1.5Z"
        fill="currentColor"
        fillOpacity={0.14}
      />
    </ResourceGlyph>
  )
}

export function ResourceShotsGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <rect
        x={3.5}
        y={4.5}
        width={6}
        height={5.75}
        rx={1.25}
        fill="currentColor"
        fillOpacity={0.16}
      />
      <rect
        x={3.5}
        y={13.75}
        width={6}
        height={5.75}
        rx={1.25}
        fill="currentColor"
        fillOpacity={0.16}
      />
      <path d="M13 5.75h7.5M13 9h5M13 15h7.5M13 18.25h5" />
    </ResourceGlyph>
  )
}

export function ResourceUnderstandingGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path
        d="M3 12c2-4.25 5-6.25 9-6.25s7 2 9 6.25c-2 4.25-5 6.25-9 6.25S5 16.25 3 12Z"
        fill="currentColor"
        fillOpacity={0.12}
      />
      <circle cx={12} cy={12} r={3.25} />
      <circle cx={12} cy={12} r={0.75} fill="currentColor" stroke="none" />
    </ResourceGlyph>
  )
}

export function ResourceFrameGlyph(props: ResourceGlyphProps) {
  return (
    <ResourceGlyph {...props}>
      <path
        d="m3.5 15.75 4.75-4.5 4.5 4.5 2.5-2.5 5.25 5.25-1.5 1H5Z"
        fill="currentColor"
        fillOpacity={0.14}
        stroke="none"
      />
      <rect x={3.25} y={4.5} width={17.5} height={15} rx={2.25} />
      <path d="m3.5 15.75 4.75-4.5 4.5 4.5 2.5-2.5 5.25 5.25" />
      <circle cx={15.75} cy={8.5} r={1} fill="currentColor" stroke="none" />
    </ResourceGlyph>
  )
}
