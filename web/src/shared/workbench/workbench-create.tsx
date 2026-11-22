import type { ComponentPropsWithRef } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { CreatableEntry } from './artifact'
import { NO_HOVER_WASH_CLASS } from './workbench-button'

// 「+」的外形：比白卡略灰的小块、轻投影（深色下是高一档的面），正在新建时也保留
const CREATE_CHIP_CLASS =
  'size-7.5 shrink-0 rounded-control bg-surface text-on-surface-muted shadow-[var(--shadow-panel-card),var(--shadow-specular)] dark:bg-surface-container-high'

type CreateButtonProps = Omit<ComponentPropsWithRef<typeof IconButton>, 'name' | 'size' | 'variant'>

/**
 * 「+」新建按钮，顶栏和收起的竖条共用：悬停变成白卡浮起，菜单展开时投影更重、外圈一道细线。
 * 其余属性原样给按钮（当菜单的触发器时由菜单补上）。
 */
export function CreateButton({ className, ...props }: CreateButtonProps) {
  return (
    <IconButton
      className={cn(
        CREATE_CHIP_CLASS,
        NO_HOVER_WASH_CLASS,
        // 深色的静止底色写在 dark: 上，悬停、展开换回白卡也要各写一遍 dark:，否则静止底色盖过它们
        'hover:bg-card hover:text-on-surface hover:shadow-[var(--shadow-pill),var(--shadow-specular)] dark:hover:bg-card',
        'data-[state=open]:bg-card data-[state=open]:text-on-surface data-[state=open]:shadow-[var(--shadow-panel),0_0_0_1px_var(--color-panel-line-strong),var(--shadow-specular)] dark:data-[state=open]:bg-card',
        className,
      )}
      name="add"
      size="sm"
      {...props}
    />
  )
}

/** 正在新建 `label` 时顶替「+」：外形不变，「+」换成转圈；不可点，读屏念「正在新建 <label>」。 */
export function CreatingMark({ className, label }: { className?: string; label: string }) {
  return (
    <span
      aria-label={`正在新建 ${label}`}
      className={cn(CREATE_CHIP_CLASS, 'grid place-items-center', className)}
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
    // 不拦菜单外的指针：菜单开着时点页签，一下就切过去并关掉菜单
    <MenuRoot modal={false}>
      <MenuTrigger asChild>
        <CreateButton label="新建" />
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
