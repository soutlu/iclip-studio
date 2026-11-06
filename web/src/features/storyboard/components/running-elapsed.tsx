import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useElapsed } from '@/shared/ui/media-preview'

type RunningElapsedProps = {
  since: string
  label?: string | undefined
  iconClassName?: string
}

export function RunningElapsed({ since, iconClassName, label }: RunningElapsedProps) {
  const elapsed = useElapsed(since)
  return (
    <>
      {label === undefined ? (
        <Icon
          className={cn('motion-safe:animate-spin', iconClassName)}
          decorative
          name="loading"
          size="sm"
        />
      ) : (
        <span>{label}</span>
      )}
      <span className="tabular-nums">{elapsed}</span>
    </>
  )
}
