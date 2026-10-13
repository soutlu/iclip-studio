/** 详情视频下方的一行分段：切这张卡的镜头组、切这一组的版本。只有一组不出组分段，只有一版不出版本分段。 */

import { useEffect, useRef, type ReactNode } from 'react'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import type { LibraryShotGroup } from '../library.api'
import { groupNamesOf, type LibraryVersion } from '../library-media'

const ROW_CLASS =
  'flex shrink-0 flex-wrap items-center justify-center gap-x-6 gap-y-2.5 px-6 pt-1 pb-4.5 max-md:gap-x-4 max-md:px-4'

type LibraryVersionBarProps = {
  groups: readonly LibraryShotGroup[]
  /** 正在播的那一组与它的全部版本、正在播的那一版。 */
  group: LibraryShotGroup
  versions: readonly LibraryVersion[]
  version: LibraryVersion
  /** 选中一版；点组时给那一组最新的一版。 */
  onSelect: (jobId: string) => void
}

export function LibraryVersionBar({
  groups,
  group,
  versions,
  version,
  onSelect,
}: LibraryVersionBarProps) {
  if (groups.length < 2 && versions.length < 2) return null
  const names = groupNamesOf(groups)
  const current = names[groups.indexOf(group)] ?? ''

  return (
    <div className={ROW_CLASS}>
      {groups.length < 2 ? null : (
        <SegmentUnit caption="镜头组" label="镜头组" selected={current}>
          {groups.map((item, order) => {
            const name = names[order] ?? ''
            const latest = item.versions.at(-1)
            return (
              <button
                aria-pressed={item === group}
                className="library-viewer-segment ui-focus"
                key={name}
                onClick={() => {
                  if (latest !== undefined) onSelect(latest.jobId)
                }}
                title={`${item.shotIndex === null ? name : `镜头组 ${name}`} · ${item.versions.length} 版`}
                type="button"
              >
                {name}
              </button>
            )
          })}
        </SegmentUnit>
      )}
      {versions.length < 2 ? null : (
        <SegmentUnit caption="版本" label="该镜头组的版本" selected={version.jobId}>
          {versions.map((item, order) => (
            <button
              aria-pressed={item.jobId === version.jobId}
              className="library-viewer-segment ui-focus"
              key={item.jobId}
              onClick={() => onSelect(item.jobId)}
              title={`${item.label} · ${formatRelativeTime(item.finishedAt)}`}
              type="button"
            >
              {order + 1}
              {item.kind === 'composite' ? (
                <span className="library-viewer-segment-note">合成</span>
              ) : null}
            </button>
          ))}
        </SegmentUnit>
      )}
    </div>
  )
}

/** 详情读回来之前照卡上的组数与版数占住这一行，读回来不跳（窄屏折成两行也一样）。
 * 卡面那一组有几版要等详情；多组时假定多出来的版都在卡面那一组。这一行不会出现时什么都不占。 */
export function LibraryVersionBarSkeleton({
  groupCount,
  versionCount,
}: {
  groupCount: number
  versionCount: number
}) {
  const faceVersions = versionCount - groupCount + 1
  if (groupCount < 2 && faceVersions < 2) return null
  return (
    <div className={ROW_CLASS} role="status">
      <span className="sr-only">正在读取镜头组与版本</span>
      {groupCount < 2 ? null : <SkeletonUnit caption="镜头组" count={groupCount} />}
      {faceVersions < 2 ? null : <SkeletonUnit caption="版本" count={faceVersions} />}
    </div>
  )
}

/** 与真分段同样的说明文字和轨道，里面是空的分段位，宽度与折行跟真的一致。 */
function SkeletonUnit({ caption, count }: { caption: string; count: number }) {
  return (
    <div aria-hidden="true" className="flex max-w-full min-w-0 items-center gap-2">
      <span className="shrink-0 text-caption text-on-surface-faint">{caption}</span>
      <span className="library-viewer-segments motion-safe:animate-pulse">
        {Array.from({ length: count }, (_, order) => (
          <span className="library-viewer-segment" key={order} />
        ))}
      </span>
    </div>
  )
}

/** 小字说明加一条分段；分段里不折行，放不下就在自己里面横向滑。 */
function SegmentUnit({
  caption,
  label,
  selected,
  children,
}: {
  caption: string
  label: string
  /** 选中项的标识，变了就把选中项滚进可视区。 */
  selected: string
  children: ReactNode
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  // 只动分段自己的 scrollLeft：scrollIntoView 会连弹层与页面一起滚。
  useEffect(() => {
    const track = trackRef.current
    const pressed = track?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (track === null || pressed === undefined || pressed === null) return
    const trackBounds = track.getBoundingClientRect()
    const pressedBounds = pressed.getBoundingClientRect()
    if (pressedBounds.left < trackBounds.left)
      track.scrollLeft -= trackBounds.left - pressedBounds.left
    else if (pressedBounds.right > trackBounds.right)
      track.scrollLeft += pressedBounds.right - trackBounds.right
  }, [selected])

  return (
    <div className="flex max-w-full min-w-0 items-center gap-2">
      {/* 分段自己带 aria-label，说明文字不再给读屏读一遍。 */}
      <span aria-hidden="true" className="shrink-0 text-caption text-on-surface-faint">
        {caption}
      </span>
      <div aria-label={label} className="library-viewer-segments" ref={trackRef} role="group">
        {children}
      </div>
    </div>
  )
}
