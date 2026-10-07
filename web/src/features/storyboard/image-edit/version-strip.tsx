/** 这一帧（制作页是这张图）出现过的图，竖排在舞台右缘（窄屏横排在舞台下方）。只画调用方给的条目，不查数据。 */

import { useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { useTakeElapsed } from '../components/use-take-elapsed'
import { phaseOfStatus } from '../shots'
import { entryBaseUrl, entryLabel, entryName, type StripEntry } from './edit-history'
import type { EditorWords } from './edit-target'

type VersionStripProps = {
  entries: readonly StripEntry[]
  /** 在用那一格的称呼与整条的可访问名，随所在页面变。 */
  words: Pick<EditorWords, 'current' | 'versions'>
  currentUrl: string
  /** 替换进行中锁住整条：这段时间换选中会让守卫认错当前帧。 */
  disabled: boolean
  selectedKey: string
  onSelect: (key: string) => void
  /** 完成了、本次打开期间见过它在跑、还没点开过的结果，挂小绿点。 */
  isUnseen: (entry: StripEntry) => boolean
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  /** 条尾的操作，如选中条目的「⋯」菜单。 */
  actions?: ReactNode
}

/** 一格读不出图就只换这一格，整条仍能翻；地址换了由调用点重新挂载重置。 */
function SlotImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <MediaFallback className="size-full p-1" compact kind="image" />
  return (
    <img
      alt=""
      className="image-edit-version-image"
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  )
}

/** 生成中：绿色细圆环加走表，从提交时刻算起，与工作台成片卡一致。 */
function RunningState({ since }: { since: string }) {
  const elapsed = useTakeElapsed(since)
  return (
    <span className="image-edit-version-state">
      <Icon className="text-primary motion-safe:animate-spin" decorative name="loading" size="sm" />
      <span className="tabular-nums">{elapsed}</span>
    </span>
  )
}

function EntryState({ entry }: { entry: StripEntry }) {
  if (entry.kind === 'failed')
    return (
      <span className="image-edit-version-state">
        <Icon className="text-error" decorative name="alert" size="sm" />
      </span>
    )
  if (entry.kind !== 'pending') return null
  if (phaseOfStatus(entry.job.status) === 'queued')
    return (
      <span className="image-edit-version-state">
        <Icon className="text-on-surface-muted" decorative name="duration" size="sm" />
      </span>
    )
  return <RunningState since={entry.job.createdAt} />
}

export function VersionStrip({
  entries,
  words,
  currentUrl,
  disabled,
  selectedKey,
  onSelect,
  isUnseen,
  hasMore,
  loadingMore,
  onLoadMore,
  actions,
}: VersionStripProps) {
  return (
    <div className="image-edit-versions">
      <div aria-label={words.versions} className="image-edit-versions-list" role="group">
        {entries.map((entry) => {
          const baseUrl = entryBaseUrl(entry, currentUrl)
          const unseen = isUnseen(entry)
          const name = `${entryName(entry, words.current)}${unseen ? ' · 新结果' : ''}`
          return (
            <button
              aria-label={name}
              aria-pressed={entry.key === selectedKey}
              className="image-edit-version ui-focus"
              disabled={disabled}
              key={entry.key}
              onClick={() => onSelect(entry.key)}
              title={name}
              type="button"
            >
              <span className="image-edit-version-slot">
                <SlotImage key={baseUrl} src={baseUrl} />
                <EntryState entry={entry} />
                {unseen ? <span className="image-edit-version-dot" /> : null}
              </span>
              <span className="image-edit-version-label">{entryLabel(entry, words.current)}</span>
            </button>
          )
        })}
        {hasMore ? (
          <button
            className="image-edit-version ui-focus"
            disabled={disabled || loadingMore}
            onClick={onLoadMore}
            title="加载更早的图片"
            type="button"
          >
            <span className="image-edit-version-slot image-edit-version-more">
              <Icon
                className={cn(loadingMore && 'motion-safe:animate-spin')}
                decorative
                name={loadingMore ? 'loading' : 'history'}
                size="sm"
              />
            </span>
            <span className="image-edit-version-label">更早</span>
          </button>
        ) : null}
      </div>
      {actions ? (
        <>
          <span aria-hidden="true" className="image-edit-versions-divider" />
          {actions}
        </>
      ) : null}
    </div>
  )
}
