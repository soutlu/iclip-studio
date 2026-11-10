import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

type ResourceTileProps = {
  /** 白色符号，取 `resource-*` 实心图形。 */
  icon: IconName
  /** 底色，取 `text-resource-*` 类别色。 */
  tone: string
  className?: string | undefined
}

/** 资源的实心图标块：类别色铺满圆角方块，顶部一层微光，白色符号占约五分之三。 */
export function ResourceTile({ className, icon, tone }: ResourceTileProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-resource-tile bg-current bg-(image:--resource-tile-gloss) shadow-(--shadow-resource-tile)',
        tone,
        className,
      )}
    >
      <Icon className="size-[62%] text-on-resource" decorative name={icon} />
    </span>
  )
}
