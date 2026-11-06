import { useEffect, useRef, type ReactNode } from 'react'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import type { LibraryShotGroup } from '../library.api'
import { groupNamesOf, type LibraryVersion } from '../library-media'

const ROW_CLASS =
  'flex shrink-0 flex-wrap items-center justify-center gap-x-6 gap-y-2.5 px-6 pt-1 pb-4.5 max-md:gap-x-4 max-md:px-4'

type LibraryVersionBarProps = {
  groups: readonly LibraryShotGroup[]
  group: LibraryShotGroup
  versions: readonly LibraryVersion[]
  version: LibraryVersion
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

function SegmentUnit({
  caption,
  label,
  selected,
  children,
}: {
  caption: string
  label: string
  selected: string
  children: ReactNode
}) {
  const trackRef = useRef<HTMLDivElement>(null)
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
      <span aria-hidden="true" className="shrink-0 text-caption text-on-surface-faint">
        {caption}
      </span>
      <div aria-label={label} className="library-viewer-segments" ref={trackRef} role="group">
        {children}
      </div>
    </div>
  )
}
