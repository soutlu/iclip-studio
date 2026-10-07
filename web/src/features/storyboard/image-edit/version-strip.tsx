/** 这一帧（制作页是这张图）出现过的图，竖排在舞台右缘（窄屏横排在舞台下方）。只画调用方给的条目，不查数据。 */

import { useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { RunningElapsed } from '../components/running-elapsed'
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
  /** 按描述再生成（制作页的生成图）：条目之后多一格「再生成」，选中时舞台与输入卡换成再生成。 */
  regenerate?: { selected: boolean; onSelect: () => void } | undefined
}

/** 一格读不出图就只换这一格，整条仍能翻；地址换了由调用点重新挂载重置。按描述生成、还没出图的任务没有底图（空串），空着。 */
function SlotImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (src === '') return null
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
  // 生成中：绿色细圆环加走表。
  return (
    <span className="image-edit-version-state">
      <RunningElapsed iconClassName="text-primary" since={entry.job.createdAt} />
    </span>
  )
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
  regenerate,
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
        {regenerate === undefined ? null : (
          <button
            aria-pressed={regenerate.selected}
            className="image-edit-version ui-focus"
            disabled={disabled}
            onClick={regenerate.onSelect}
            title="按描述再生成一张"
            type="button"
          >
            <span className="image-edit-version-slot image-edit-version-more">
              <Icon decorative name="refresh" size="sm" />
            </span>
            <span className="image-edit-version-label">再生成</span>
          </button>
        )}
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
