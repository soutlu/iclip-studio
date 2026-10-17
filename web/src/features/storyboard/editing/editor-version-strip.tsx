import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { RunningElapsed } from '../components/running-elapsed'
import { VersionThumb } from '../components/version-thumb'

export type VersionStripEntry = {
  key: string
  label: string | undefined
  name: string
  poster: string | undefined
  running: { since: string; label?: string } | undefined
  failed?: boolean | undefined
  disabled?: boolean | undefined
  unseen: boolean
}

type EditorVersionStripProps = {
  entries: readonly VersionStripEntry[]
  selectedKey: string
  onSelect: (key: string) => void
  title?: string | undefined
}

function Thumbnail({ src }: { src: string | undefined }) {
  const [failed, setFailed] = useState(false)
  if (src === undefined || failed)
    return (
      <span className="version-thumb-empty">
        <Icon decorative name="video" size="sm" />
      </span>
    )
  return <img alt="" draggable={false} onError={() => setFailed(true)} src={src} />
}

const stateOf = (entry: VersionStripEntry) => {
  if (entry.failed === true)
    return (
      <>
        <Icon className="video-editor-version-failed" decorative name="alert" size="sm" />
        失败
      </>
    )
  return entry.running === undefined ? undefined : (
    <RunningElapsed since={entry.running.since} label={entry.running.label} />
  )
}

export function EditorVersionStrip({
  entries,
  selectedKey,
  onSelect,
  title,
}: EditorVersionStripProps) {
  if (entries.length === 0) return null
  return (
    <div aria-label="视频版本" className="video-editor-versions" role="group">
      {title === undefined ? null : <span className="video-editor-versions-title">{title}</span>}
      {entries.map((entry) => (
        <VersionThumb
          key={entry.key}
          disabled={entry.disabled}
          label={entry.label}
          name={entry.name}
          onClick={() => onSelect(entry.key)}
          selected={entry.key === selectedKey}
          state={stateOf(entry)}
          unseen={entry.unseen}
        >
          <Thumbnail key={entry.poster} src={entry.poster} />
        </VersionThumb>
      ))}
    </div>
  )
}
