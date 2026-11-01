import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'

const CARD_CLASS =
  'flex h-12 min-w-0 items-center gap-2.5 rounded-md bg-surface-container-low px-2.5 text-left text-body text-on-surface'

/** 摘要卡片左侧的图标块。 */
export function CardGlyph({ name, className }: { name: IconName; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-sm bg-top-layer text-on-surface-variant',
        className,
      )}
    >
      <Icon decorative name={name} size="md" />
    </span>
  )
}

/** 卡片尾部的小角标：版本号、时限、次数。 */
export function CardBadge({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <span className="inline-flex h-4.5 shrink-0 items-center gap-0.5 rounded-xs bg-state-active px-1.5 text-caption font-medium text-on-surface-variant tabular-nums">
      {icon === undefined ? null : <Icon decorative name={icon} size="xs" />}
      {children}
    </span>
  )
}

/** 红色的提示图标，原因在悬停提示与可访问名里。 */
export function AlertGlyph({ reason }: { reason: string }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span className="inline-grid shrink-0 place-items-center text-error">
          <Icon label={reason} name="alert" size="sm" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </TooltipRoot>
  )
}

type ResourceCardProps = {
  icon: IconName
  name: string
  /** 名字被截断时，悬停看全名与说明。 */
  tip: string
  trailing?: ReactNode
  /** 不给就是不可点的静态卡片（插件、查看历史版本时）。 */
  onOpen?: (() => void) | undefined
  /** 点开后右侧打开的是这一张。 */
  active?: boolean
  label?: string
}

/** 左侧各节的摘要卡片：图标、名字、尾部小件，单行。 */
export function ResourceCard({
  active = false,
  icon,
  label,
  name,
  onOpen,
  tip,
  trailing,
}: ResourceCardProps) {
  const { rootProps, triggerProps } = useTabTooltip()
  const body = (
    <>
      <CardGlyph name={icon} />
      <span className={cn('min-w-0 flex-1 truncate', active && 'font-medium')}>{name}</span>
      {trailing === undefined ? null : (
        <span className="flex shrink-0 items-center gap-1">{trailing}</span>
      )}
    </>
  )
  return (
    <TooltipRoot {...rootProps}>
      <TooltipTrigger asChild {...triggerProps}>
        {onOpen === undefined ? (
          <div className={CARD_CLASS}>{body}</div>
        ) : (
          <button
            aria-current={active ? 'true' : undefined}
            aria-label={label}
            className={cn(
              CARD_CLASS,
              'ui-state cursor-pointer ui-focus',
              active && 'bg-surface-container-high',
            )}
            onClick={onOpen}
            type="button"
          >
            {body}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">{tip}</TooltipContent>
    </TooltipRoot>
  )
}

/** 空的一节在草稿里放一张描边的添加卡；`blockedReason` 时置灰、点了不动，原因在提示里。 */
export function AddCard({
  blockedReason,
  label,
  onClick,
}: {
  blockedReason?: string | undefined
  label: string
  onClick: () => void
}) {
  const { rootProps, triggerProps } = useTabTooltip()
  return (
    <TooltipRoot {...rootProps} open={rootProps.open && blockedReason !== undefined}>
      <TooltipTrigger asChild {...triggerProps}>
        <button
          aria-disabled={blockedReason === undefined ? undefined : true}
          className={cn(
            CARD_CLASS,
            'ui-state cursor-pointer bg-transparent text-on-surface-variant ring-1 ring-border ui-focus ring-inset',
          )}
          onClick={() => {
            if (blockedReason === undefined) onClick()
          }}
          type="button"
        >
          <CardGlyph className="bg-transparent" name="add" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      </TooltipTrigger>
      {blockedReason === undefined ? null : <TooltipContent>{blockedReason}</TooltipContent>}
    </TooltipRoot>
  )
}

/** 查看历史版本时空的一节：一道淡色短线表示没配置。 */
export function EmptyDash() {
  return (
    <span className="leading-12 text-on-surface-faint" role="img" aria-label="未配置">
      —
    </span>
  )
}
