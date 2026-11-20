import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { CreatableEntry } from './artifact'

/** 正在新建 `label` 时顶替「+」的转圈：不可点，读屏念「正在新建 <label>」。 */
export function CreatingMark({ className, label }: { className?: string; label: string }) {
  return (
    <span
      aria-label={`正在新建 ${label}`}
      className={cn('grid size-7.5 shrink-0 place-items-center text-on-surface-muted', className)}
      role="status"
    >
      <Icon className="animate-spin" decorative name="loading" size="sm" />
    </span>
  )
}

type CreateMenuProps = {
  entries: readonly CreatableEntry[]
  creating: string | undefined
  onCreate: (entry: CreatableEntry) => void
}

/** 页签右边的「+」：点开列出能新建的类型，正在建时换成转圈。 */
export function CreateMenu({ entries, creating, onCreate }: CreateMenuProps) {
  const pending = entries.find((entry) => entry.type === creating)
  if (pending !== undefined) return <CreatingMark label={pending.label} />
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <IconButton
          className="size-7.5 shrink-0 rounded-control bg-card text-on-surface-muted shadow-[var(--shadow-pill),var(--shadow-specular)] hover:text-on-surface data-[state=open]:text-on-surface"
          label="新建"
          name="add"
          size="sm"
        />
      </MenuTrigger>
      <MenuSurface align="start" className="min-w-48">
        {entries.map((entry) => (
          <MenuItem
            aria-label={`新建 ${entry.label}`}
            className="h-9.5 rounded-control pr-2.5 pl-1.5 text-label font-semibold"
            key={entry.type}
            onSelect={() => onCreate(entry)}
            trailing={<span className="text-caption font-medium text-on-surface-faint">新建</span>}
          >
            <span className="mr-2.25 inline-grid size-6.5 place-items-center rounded-sm bg-surface align-middle ring-1 ring-panel-line-strong ring-inset">
              <Icon className="text-tone-copper" decorative name={entry.icon} size="md" />
            </span>
            {entry.label}
          </MenuItem>
        ))}
      </MenuSurface>
    </MenuRoot>
  )
}
