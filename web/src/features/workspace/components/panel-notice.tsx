type PanelNoticeProps = {
  text: string
  hint?: string
}

export function PanelNotice({ hint, text }: PanelNoticeProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-body text-on-surface-variant">{text}</p>
      {hint === undefined ? null : <p className="text-body-sm text-on-surface-faint">{hint}</p>}
    </div>
  )
}
