import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'

const CARD_CLASS =
  'flex h-12 min-w-0 items-center gap-2.5 rounded-md bg-surface-container-low px-2.5 text-left text-body text-on-surface'

const RESOURCE_GLYPHS: Partial<Record<IconName, { icon: IconName; className: string }>> = {
  agent: { icon: 'resource-agent', className: 'bg-resource-agent/10 text-resource-agent' },
  skill: { icon: 'resource-skill', className: 'bg-resource-skill/10 text-resource-skill' },
  folder: {
    icon: 'resource-workspace',
    className: 'bg-resource-workspace/10 text-resource-workspace',
  },
  film: { icon: 'resource-video', className: 'bg-resource-video/10 text-resource-video' },
  layers: { icon: 'resource-project', className: 'bg-resource-project/10 text-resource-project' },
  'mcp-server': {
    icon: 'resource-mcp',
    className: 'bg-resource-connection/10 text-resource-connection',
  },
  provider: {
    icon: 'resource-provider',
    className: 'bg-resource-provider/10 text-resource-provider',
  },
  plugin: {
    icon: 'resource-plugin',
    className: 'bg-resource-connection/10 text-resource-connection',
  },
  'shot-list': {
    icon: 'resource-shots',
    className: 'bg-resource-project/10 text-resource-project',
  },
  'video-understanding': {
    icon: 'resource-understanding',
    className: 'bg-resource-video/10 text-resource-video',
  },
  'video-type': { icon: 'resource-frame', className: 'bg-resource-video/10 text-resource-video' },
}

export function CardGlyph({ name, className }: { name: IconName; className?: string | undefined }) {
  const resource = RESOURCE_GLYPHS[name]
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-sm bg-top-layer text-on-surface-variant',
        resource?.className,
        className,
      )}
    >
      <Icon decorative name={resource?.icon ?? name} size={resource === undefined ? 'md' : 'lg'} />
    </span>
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
  tip: string
  trailing?: ReactNode
  onOpen?: (() => void) | undefined
  active?: boolean
  muted?: boolean
  label?: string
}

export function ResourceCard({
  active = false,
  icon,
  label,
  muted = false,
  name,
  onOpen,
  tip,
  trailing,
}: ResourceCardProps) {
  const { rootProps, triggerProps } = useTabTooltip()
  const fade = muted ? 'opacity-(--state-disabled-content)' : undefined
  const body = (
    <>
      <CardGlyph className={fade} name={icon} />
      <span className={cn('min-w-0 flex-1 truncate', active && 'font-medium', fade)}>{name}</span>
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

export function EmptyDash() {
  return (
    <span className="leading-12 text-on-surface-faint" role="img" aria-label="未配置">
      —
    </span>
  )
}
