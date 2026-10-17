import { useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { PLACEHOLDER_VIDEO_RATIO, snapshotWidthFor } from '../library-layout'
import { cardOpenerProps } from './card-focus'

type Props = {
  label: string
  openLabel: string
  cardId: string
  videoUrl: string
  width: number
  onOpen: () => void
  badges?: ReactNode
  children: ReactNode
}

export function PlaceholderRatioCard({
  label,
  openLabel,
  cardId,
  videoUrl,
  width,
  onOpen,
  badges,
  children,
}: Props) {
  const poster =
    width > 0
      ? videoSnapshotUrl(videoUrl, snapshotWidthFor(width, window.devicePixelRatio || 1))
      : null
  const [ratio, setRatio] = useState(PLACEHOLDER_VIDEO_RATIO)
  const [posterState, setPosterState] = useState<'loading' | 'loaded' | 'failed'>('loading')

  return (
    <article aria-label={label} className="library-card group flex flex-col">
      <div
        className="library-card-media relative overflow-hidden rounded-md bg-surface-container-low"
        style={{ aspectRatio: ratio }}
      >
        {poster === null ? null : poster === undefined || posterState === 'failed' ? (
          <span className="absolute inset-0 grid place-items-center text-on-surface-variant">
            <Icon decorative name="video" size="xl" />
          </span>
        ) : (
          <img
            alt=""
            className={cn(
              'library-card-poster absolute inset-0 size-full object-cover',
              posterState === 'loaded' && 'library-card-poster-loaded',
            )}
            decoding="async"
            loading="lazy"
            onError={() => setPosterState('failed')}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) setRatio(naturalWidth / naturalHeight)
              setPosterState('loaded')
            }}
            src={poster}
          />
        )}
        <button
          aria-label={openLabel}
          className="absolute inset-0 cursor-pointer rounded-md ui-focus"
          {...cardOpenerProps(cardId)}
          onClick={onOpen}
          type="button"
        />
        {badges}
      </div>
      <div className="px-0.5 pt-2.5">{children}</div>
    </article>
  )
}
