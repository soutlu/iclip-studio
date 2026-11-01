import { Icon } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import {
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import type { Agent, AgentVersion } from '../agents.api'

const DRAFT = 'draft'

/** 发布人的头像：名字的首字压在圆底上；本系统里已没有这个人时是一个空圆。 */
function PublisherAvatar({ name }: { name: string | null }) {
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-container-high text-caption font-medium text-on-surface-variant"
    >
      {name === null ? '' : Array.from(name)[0]}
    </span>
  )
}

function DraftDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-on-surface-variant" />
}

type AgentHeaderProps = {
  agents: readonly Agent[]
  current: { id: string; name: string; activeVersionId: string | null }
  onSelectAgent: (id: string) => void
  definitionOpen: boolean
  onEditDefinition: () => void
  /** 版本号从大到小；还在读时为 undefined。 */
  versions: readonly AgentVersion[] | undefined
  /** 正在看的版本，看草稿时为 null。 */
  viewingVersionId: string | null
  onViewVersion: (versionId: string | null) => void
  /** 草稿与当前版本不同（含还没保存的修改）。 */
  unpublished: boolean
}

/** 左栏头部：切换 agent、改定义、看版本。归档的 agent 不进切换菜单。 */
export function AgentHeader({
  agents,
  current,
  definitionOpen,
  onEditDefinition,
  onSelectAgent,
  onViewVersion,
  unpublished,
  versions,
  viewingVersionId,
}: AgentHeaderProps) {
  const viewing = versions?.find((item) => item.id === viewingVersionId)
  const switchable = agents.filter((agent) => agent.status === 'active' || agent.id === current.id)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <MenuRoot>
        <MenuTrigger
          aria-label={`切换 Agent，当前：${current.name}`}
          className="flex h-10 max-w-[min(420px,100%)] min-w-0 ui-state cursor-pointer items-center gap-2.5 rounded-sm pr-2 pl-1 text-left text-on-surface ui-focus data-[state=open]:bg-state-active"
        >
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-sm bg-surface-container-high text-on-surface-variant"
          >
            <Icon decorative name="agent" size="md" />
          </span>
          <span className="min-w-0 truncate text-title font-semibold">{current.name}</span>
          <Icon className="shrink-0 text-on-surface-faint" decorative name="expand" size="sm" />
        </MenuTrigger>
        <MenuSurface align="start" className="max-w-[min(420px,calc(100vw-32px))] min-w-60">
          <MenuRadioGroup onValueChange={onSelectAgent} value={current.id}>
            {switchable.map((agent) => (
              <MenuRadioItem key={agent.id} value={agent.id}>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon
                    className="shrink-0 text-on-surface-variant"
                    decorative
                    name="agent"
                    size="sm"
                  />
                  <span className="min-w-0 truncate">{agent.name}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSurface>
      </MenuRoot>
      <IconButton
        aria-pressed={definitionOpen}
        className={cn(definitionOpen && 'bg-state-active text-on-surface')}
        label="编辑 Agent 定义"
        name="edit"
        onClick={onEditDefinition}
        size="sm"
      />
      <span className="min-w-0 flex-1" />
      <MenuRoot>
        <MenuTrigger
          aria-label={`查看版本，当前：${viewing === undefined ? '草稿' : `v${viewing.version}`}`}
          className="inline-flex h-8 shrink-0 ui-state cursor-pointer items-center gap-1.5 rounded-full pr-2 pl-3 text-body text-on-surface tabular-nums ring-1 ring-border ui-focus ring-inset data-[state=open]:bg-state-active"
        >
          {viewing === undefined ? (
            <>
              草稿
              {unpublished ? <DraftDot /> : null}
            </>
          ) : (
            `v${viewing.version}`
          )}
          <Icon className="text-on-surface-faint" decorative name="expand" size="sm" />
        </MenuTrigger>
        <MenuSurface align="end" className="min-w-58">
          <MenuRadioGroup
            onValueChange={(value) => onViewVersion(value === DRAFT ? null : value)}
            value={viewingVersionId ?? DRAFT}
          >
            <MenuRadioItem aria-label={unpublished ? '草稿，有未发布的修改' : '草稿'} value={DRAFT}>
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex-1">草稿</span>
                {unpublished ? <DraftDot /> : null}
              </span>
            </MenuRadioItem>
            {versions !== undefined && versions.length > 0 ? <MenuSeparator /> : null}
            {versions?.map((item) => {
              const isCurrent = item.id === current.activeVersionId
              const when = formatRelativeTime(item.createdAt)
              return (
                <MenuRadioItem
                  aria-label={[
                    `v${item.version}`,
                    isCurrent ? '当前版本' : null,
                    item.createdByName,
                    when,
                  ]
                    .filter((part) => part !== null)
                    .join('，')}
                  key={item.id}
                  value={item.id}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="tabular-nums">v{item.version}</span>
                    {isCurrent ? (
                      <span className="inline-flex h-4.5 items-center rounded-xs bg-inverse-surface px-1.5 text-caption font-medium text-inverse-on-surface">
                        当前
                      </span>
                    ) : null}
                    <span className="ml-auto pl-3 text-label text-on-surface-variant tabular-nums">
                      {when}
                    </span>
                    <PublisherAvatar name={item.createdByName} />
                  </span>
                </MenuRadioItem>
              )
            })}
          </MenuRadioGroup>
        </MenuSurface>
      </MenuRoot>
    </div>
  )
}
