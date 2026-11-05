import { useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { RunningElapsed } from '../components/running-elapsed'
import { VersionThumb, VersionTile } from '../components/version-thumb'
import { phaseOfStatus } from '../shots'
import { entryBaseUrl, entryLabel, entryName, type StripEntry } from './edit-history'
import type { EditorWords } from './edit-target'

type VersionStripProps = {
  entries: readonly StripEntry[]
  words: Pick<EditorWords, 'current' | 'versions'>
  currentUrl: string
  aspectRatio: string
  disabled: boolean
  selectedKey: string
  onSelect: (key: string) => void
  isUnseen: (entry: StripEntry) => boolean
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  actions?: ReactNode
  regenerate?: { selected: boolean; onSelect: () => void } | undefined
}

function SlotImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (src === '') return null
  if (failed)
    return (
      <span className="version-thumb-empty">
        <MediaFallback className="p-1" compact kind="image" />
      </span>
    )
  return <img alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} src={src} />
}

function entryState(entry: StripEntry): ReactNode {
  if (entry.kind === 'failed')
    return (
      <>
        <Icon className="image-edit-version-failed" decorative name="alert" size="sm" />
        失败
      </>
    )
  if (entry.kind !== 'pending') return undefined
  if (phaseOfStatus(entry.job.status) === 'queued')
    return <Icon decorative name="duration" size="sm" />
  return <RunningElapsed since={entry.job.createdAt} />
}

export function VersionStrip({
  entries,
  words,
  currentUrl,
  aspectRatio,
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
  if (entries.length + (hasMore ? 1 : 0) + (regenerate === undefined ? 0 : 1) < 2) return null
  return (
    <div className="image-edit-versions">
      <div aria-label={words.versions} className="image-edit-versions-list" role="group">
        {entries.map((entry) => {
          const baseUrl = entryBaseUrl(entry, currentUrl)
          const unseen = isUnseen(entry)
          const state = entryState(entry)
          const labelled =
            entry.kind === 'current' ||
            entry.kind === 'image' ||
            (entry.kind === 'pending' && phaseOfStatus(entry.job.status) === 'queued')
          return (
            <VersionThumb
              disabled={disabled}
              key={entry.key}
              label={labelled ? entryLabel(entry, words.current) : undefined}
              name={`${entryName(entry, words.current)}${unseen ? ' · 新结果' : ''}`}
              onClick={() => onSelect(entry.key)}
              ratio={aspectRatio}
              selected={entry.key === selectedKey}
              state={state}
              unseen={unseen}
            >
              <SlotImage key={baseUrl} src={baseUrl} />
            </VersionThumb>
          )
        })}
        {hasMore ? (
          <VersionTile
            disabled={disabled || loadingMore}
            icon={
              <Icon
                className={cn(loadingMore && 'motion-safe:animate-spin')}
                decorative
                name={loadingMore ? 'loading' : 'history'}
                size="sm"
              />
            }
            label="更早"
            onClick={onLoadMore}
            ratio={aspectRatio}
            title="加载更早的图片"
          />
        ) : null}
        {regenerate === undefined ? null : (
          <VersionTile
            disabled={disabled}
            icon={<Icon decorative name="refresh" size="sm" />}
            label="再生成"
            onClick={regenerate.onSelect}
            ratio={aspectRatio}
            selected={regenerate.selected}
            title="按描述再生成一张"
          />
        )}
      </div>
      {actions}
    </div>
  )
}
