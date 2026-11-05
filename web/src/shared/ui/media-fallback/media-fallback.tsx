import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

type MediaFallbackKind = 'image' | 'video'

const MAIN: Record<MediaFallbackKind, string> = {
  image: '图片加载失败',
  video: '视频加载失败',
}

type MediaFallbackProps = {
  kind: MediaFallbackKind
  hint?: string
  onRetry?: () => void
  compact?: boolean
  className?: string
}

export function MediaFallback({
  className,
  compact = false,
  hint,
  kind,
  onRetry,
}: MediaFallbackProps) {
  return (
    <span
      className={cn(
        'flex items-center justify-center text-center text-on-surface-variant',
        compact ? 'flex-wrap gap-x-2 gap-y-0.5 text-caption' : 'flex-col gap-2 text-body-sm',
        className,
      )}
    >
      <Icon decorative name={kind} size={compact ? 'sm' : 'lg'} />
      <span>{MAIN[kind]}</span>
      {hint === undefined ? null : (
        <span className={compact ? undefined : 'text-caption'}>{hint}</span>
      )}
      {onRetry === undefined ? null : (
        <Button onClick={onRetry} size="md" variant="tonal">
          重试
        </Button>
      )}
    </span>
  )
}
