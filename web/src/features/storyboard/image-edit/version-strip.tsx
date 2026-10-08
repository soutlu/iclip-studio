/** 这一帧（制作页是这张图）出现过的图，竖排在舞台右缘（窄屏横排在舞台下方）。只画调用方给的条目，不查数据。 */

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
  /** 在用那一格的称呼与整条的可访问名，随所在页面变。 */
  words: Pick<EditorWords, 'current' | 'versions'>
  currentUrl: string
  /** 分镜画幅：小图格按它定宽高比。 */
  aspectRatio: string
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
  if (failed)
    return (
      <span className="version-thumb-empty">
        <MediaFallback className="p-1" compact kind="image" />
      </span>
    )
  return <img alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} src={src} />
}

/** 盖在小图上的状态：生成中转圈加走表，排队一个时钟，失败一个感叹号加「失败」。落定的图没有。 */
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

/** 只剩一样能看的（只有当前帧，没有「更早」也没有「再生成」）时没得切，整条不显示。 */
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
          // 生成中与失败由状态遮罩自己说明，底部不再压名字；排队只有一个时钟，名字留着。
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
