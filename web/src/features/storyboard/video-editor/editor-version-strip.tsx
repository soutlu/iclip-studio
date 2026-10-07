/** 版本条：各版与未合成的编辑，竖版小画面贴在舞台右缘（窄屏横排在舞台下方）。只画调用方给的条目，不查数据。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { RunningElapsed } from '../components/running-elapsed'

export type VersionStripEntry = {
  key: string
  /** 压在缩略图底部的名字：V1、V2……，没合成的编辑叫「未合成」。 */
  label: string
  /** 可访问名，带上在途阶段与「新结果」。 */
  name: string
  poster: string | undefined
  /** 排队中只挂表；生成中、合成中挂细圆环加走表，从 `since` 算起。 */
  progress: { kind: 'queued' } | { kind: 'running'; since: string } | undefined
  /** 结果还没回来、没有可看的东西：点不动。 */
  selectable: boolean
  /** 结果刚回来、还没看过：挂小绿点。 */
  unseen: boolean
}

type EditorVersionStripProps = {
  /** 新的在前。 */
  entries: readonly VersionStripEntry[]
  selectedKey: string
  onSelect: (key: string) => void
}

/** 读不出截帧（或不是 OSS 地址、没有截帧）就只摆一个视频图标；地址换了由调用点重新挂载重置。 */
function Thumbnail({ src }: { src: string | undefined }) {
  const [failed, setFailed] = useState(false)
  if (src === undefined || failed)
    return (
      <span className="video-editor-version-empty">
        <Icon decorative name="video" size="sm" />
      </span>
    )
  return <img alt="" draggable={false} onError={() => setFailed(true)} src={src} />
}

/** 只有一条时没得切，不显示。 */
export function EditorVersionStrip({ entries, selectedKey, onSelect }: EditorVersionStripProps) {
  if (entries.length < 2) return null
  return (
    <div aria-label="视频版本" className="video-editor-versions" role="group">
      {entries.map((entry) => (
        <button
          aria-disabled={entry.selectable ? undefined : true}
          aria-label={entry.name}
          aria-pressed={entry.key === selectedKey}
          className="video-editor-version ui-focus"
          key={entry.key}
          onClick={() => {
            if (entry.selectable) onSelect(entry.key)
          }}
          title={entry.name}
          type="button"
        >
          <Thumbnail key={entry.poster} src={entry.poster} />
          {entry.progress === undefined ? null : (
            <span className="video-editor-version-state">
              {entry.progress.kind === 'running' ? (
                <RunningElapsed since={entry.progress.since} />
              ) : (
                <Icon decorative name="duration" size="sm" />
              )}
            </span>
          )}
          {entry.unseen ? <span className="video-editor-version-dot" /> : null}
          <span className="video-editor-version-label">{entry.label}</span>
        </button>
      ))}
    </div>
  )
}
