import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'

export const DIRECTORY_GRID = 'grid grid-cols-1 gap-3.5 @min-[480px]:grid-cols-2'

export const DIRECTORY_CARD =
  'relative isolate flex min-w-0 items-center gap-3.5 rounded-card border border-border px-4 py-3.5 text-left text-body text-on-surface shadow-[var(--shadow-xs)]'

// 开关的点击区铺满整张卡片（点卡片任意处都切换）；卡片里的 AlertGlyph 因此抬高一层，悬停仍能看到原因。
export const CARD_SWITCH_HIT = 'after:absolute after:inset-0 after:rounded-card'

const RESOURCE_GLYPHS: Partial<Record<IconName, { icon: IconName; className: string }>> = {
  agent: { icon: 'resource-agent', className: 'text-resource-agent' },
  skill: { icon: 'resource-skill', className: 'text-resource-skill' },
  folder: { icon: 'resource-workspace', className: 'text-resource-workspace' },
  film: { icon: 'resource-video', className: 'text-resource-video' },
  layers: { icon: 'resource-project', className: 'text-resource-project' },
  'mcp-server': { icon: 'resource-mcp', className: 'text-resource-connection' },
  provider: { icon: 'resource-provider', className: 'text-resource-provider' },
  plugin: { icon: 'resource-plugin', className: 'text-resource-connection' },
  'shot-list': { icon: 'resource-shots', className: 'text-resource-project' },
  'video-understanding': { icon: 'resource-understanding', className: 'text-resource-video' },
  'video-type': { icon: 'resource-frame', className: 'text-resource-video' },
  'resource-people': { icon: 'resource-people', className: 'text-resource-account' },
}

export function CardGlyph({ name, className }: { name: IconName; className?: string | undefined }) {
  const resource = RESOURCE_GLYPHS[name]
  if (resource === undefined)
    return (
      <span
        aria-hidden
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-sm bg-top-layer text-on-surface-variant',
          className,
        )}
      >
        <Icon decorative name={name} size="md" />
      </span>
    )
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-resource-tile bg-current bg-(image:--resource-tile-gloss) shadow-(--shadow-resource-tile)',
        resource.className,
        className,
      )}
    >
      <Icon className="size-[62%] text-on-resource" decorative name={resource.icon} />
    </span>
  )
}

export function DirectoryCardBody({
  badges,
  description,
  descriptionId,
  dimmed = false,
  icon,
  name,
  nameId,
  trailing,
}: {
  icon: IconName
  name: string
  nameId?: string | undefined
  badges?: ReactNode
  description?: string | undefined
  descriptionId?: string | undefined
  dimmed?: boolean
  trailing?: ReactNode
}) {
  const fade = dimmed ? 'opacity-55' : undefined
  return (
    <>
      <CardGlyph className={cn('size-11', fade)} name={icon} />
      <span className={cn('flex min-w-0 flex-1 flex-col gap-1', fade)}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-on-surface" id={nameId}>
            {name}
          </span>
          {badges}
        </span>
        {description === undefined || description.trim() === '' ? null : (
          <span
            className="line-clamp-2 text-body-sm leading-4.5 text-pretty text-on-surface-variant"
            id={descriptionId}
          >
            {description}
          </span>
        )}
      </span>
      {trailing === undefined || trailing === null ? null : (
        <span className="flex shrink-0 items-center gap-1">{trailing}</span>
      )}
    </>
  )
}

type DirectoryCardProps = {
  icon: IconName
  name: string
  description?: string | undefined
  tip: string
  badges?: ReactNode
  trailing?: ReactNode
  onOpen?: (() => void) | undefined
  active?: boolean
  dimmed?: boolean
  label?: string
}

export function DirectoryCard({
  active = false,
  badges,
  description,
  dimmed = false,
  icon,
  label,
  name,
  onOpen,
  tip,
  trailing,
}: DirectoryCardProps) {
  const { rootProps, triggerProps } = useTabTooltip()
  const className = cn(
    DIRECTORY_CARD,
    active ? 'bg-surface-container-low' : 'bg-background',
    onOpen === undefined ? undefined : 'ui-state cursor-pointer ui-focus',
  )
  const body = (
    <DirectoryCardBody
      badges={badges}
      description={description}
      dimmed={dimmed}
      icon={icon}
      name={name}
      trailing={trailing}
    />
  )
  return (
    <TooltipRoot {...rootProps}>
      <TooltipTrigger asChild {...triggerProps}>
        {onOpen === undefined ? (
          <div className={className}>{body}</div>
        ) : (
          <button
            aria-current={active ? 'true' : undefined}
            aria-label={label}
            className={className}
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

export function CardBadge({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <span className="inline-flex h-4.5 shrink-0 items-center gap-0.5 rounded-xs bg-state-active px-1.5 text-caption font-medium text-on-surface-variant tabular-nums">
      {icon === undefined ? null : <Icon decorative name={icon} size="xs" />}
      {children}
    </span>
  )
}

export function AlertGlyph({ reason }: { reason: string }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span className="layer-local-1 relative inline-grid shrink-0 place-items-center text-error">
          <Icon label={reason} name="alert" size="sm" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </TooltipRoot>
  )
}

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
          className="flex min-w-0 ui-state cursor-pointer items-center gap-3.5 rounded-card border border-border px-4 py-3.5 text-left text-body text-on-surface-variant ui-focus"
          onClick={() => {
            if (blockedReason === undefined) onClick()
          }}
          type="button"
        >
          <CardGlyph
            className="size-11 rounded-md border border-border bg-transparent"
            name="add"
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      </TooltipTrigger>
      {blockedReason === undefined ? null : <TooltipContent>{blockedReason}</TooltipContent>}
    </TooltipRoot>
  )
}

export function EmptyDash() {
  return (
    <span className="leading-12 text-on-surface-faint" role="img" aria-label="未配置">
      —
    </span>
  )
}
