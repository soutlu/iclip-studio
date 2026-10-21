import { useState, type ReactNode, type Ref, type SyntheticEvent } from 'react'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogTitle } from '@/shared/ui/dialog'
import { VideoPlayer } from '@/shared/ui/video-player'

export function ViewerPending({
  title,
  error,
  onClose,
  onRetry,
}: {
  title: string
  error: string | null
  onClose: () => void
  onRetry: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <DialogTitle className="sr-only">{title}</DialogTitle>
      {error === null ? (
        <p className="text-body-sm text-on-surface-variant" role="status">
          正在读取…
        </p>
      ) : (
        <>
          <p className="text-body text-on-surface" role="alert">
            {error}
          </p>
          <div className="flex gap-2">
            <Button onClick={onRetry} size="md" variant="inverted">
              重试
            </Button>
            <Button onClick={onClose} size="md" variant="ghost">
              关闭
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export function ViewerStage({
  label,
  onClose,
  children,
}: {
  label: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <section aria-label={label} className="relative flex min-w-0 flex-1 flex-col max-md:flex-none">
      <IconButton
        className="layer-local-1 absolute top-4 right-4 size-10 rounded-full bg-surface-container-low text-on-surface"
        label="关闭"
        name="close"
        onClick={onClose}
      />
      {children}
    </section>
  )
}

type ViewerVideoProps = {
  src: string
  poster: string | undefined
  label: string
  fallbackRatio: number
  playerRef: Ref<HTMLVideoElement>
  onExpand: (currentTime: number) => void
  onLoadedMetadata?: (event: SyntheticEvent<HTMLVideoElement>) => void
  onTimeUpdate?: (event: SyntheticEvent<HTMLVideoElement>) => void
}

export function ViewerVideo({
  src,
  poster,
  label,
  fallbackRatio,
  playerRef,
  onExpand,
  onLoadedMetadata,
  onTimeUpdate,
}: ViewerVideoProps) {
  const [measuredRatio, setMeasuredRatio] = useState<number | null>(null)
  const ratio = measuredRatio ?? fallbackRatio
  return (
    <div className="relative min-h-0 flex-1 max-md:h-[56vh] max-md:flex-none">
      <div className="[container-type:size] absolute inset-3 grid place-items-center md:inset-6">
        <VideoPlayer
          autoPlay
          className="bg-surface-container-low"
          label={label}
          loop
          onExpand={onExpand}
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget
            if (videoWidth > 0 && videoHeight > 0) setMeasuredRatio(videoWidth / videoHeight)
            onLoadedMetadata?.(event)
          }}
          onTimeUpdate={onTimeUpdate}
          poster={poster}
          ref={playerRef}
          src={src}
          style={{ aspectRatio: ratio, width: `min(100cqw, ${100 * ratio}cqh)` }}
        />
      </div>
    </div>
  )
}
