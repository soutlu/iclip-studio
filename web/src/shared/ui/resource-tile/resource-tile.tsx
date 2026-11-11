import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

type ResourceTileProps = {
  icon: IconName
  className?: string | undefined
}

export function ResourceTile({ className, icon }: ResourceTileProps) {
  return (
    <span
      aria-hidden
      className={cn('grid size-8 shrink-0 place-items-center text-on-surface', className)}
    >
      <Icon className="size-4/5" decorative name={icon} />
    </span>
  )
}
