/** 当前对象的版本：竖版小画面贴在舞台右缘（窄屏横排在舞台下方），生成状态留在对应版本卡中。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { RunningElapsed } from '../components/running-elapsed'
import { VersionThumb } from '../components/version-thumb'

export type VersionStripEntry = {
  key: string
  /** 压在缩略图底部的版本名；不给时由状态遮罩自己说明。 */
  label: string | undefined
  /** 可访问名，带上「合成中」与「新结果」。 */
  name: string
  poster: string | undefined
  /** 合成中挂细圆环加走表，从 `since` 算起。 */
  running: { since: string; label?: string } | undefined
  /** 合成失败：挂警示图标与「失败」。 */
  failed?: boolean | undefined
  disabled?: boolean | undefined
  /** 还没看过的新结果：挂小绿点。 */
  unseen: boolean
}

type EditorVersionStripProps = {
  /** 新的在前。 */
  entries: readonly VersionStripEntry[]
  selectedKey: string
  onSelect: (key: string) => void
  /** 只有一条时也显示；默认只有一条时没有切换需求，不显示。 */
  showSingle?: boolean | undefined
  title?: string | undefined
}

/** 读不出截帧（或不是 OSS 地址、没有截帧）就只摆一个视频图标；地址换了由调用点重新挂载重置。 */
export function Thumbnail({ src }: { src: string | undefined }) {
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
  showSingle = false,
  title,
}: EditorVersionStripProps) {
  if (entries.length < (showSingle ? 1 : 2)) return null
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
