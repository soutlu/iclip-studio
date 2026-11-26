import type { ComponentPropsWithRef } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import type { CreatableEntry } from './artifact'
import { NO_HOVER_WASH_CLASS } from './workbench-button'

// 「+」按钮基础外观：略深于白卡的圆角块与轻投影（深色模式下抬升一档表面），创建进行中也保持一致
const CREATE_CHIP_CLASS =
  'size-7.5 shrink-0 rounded-control bg-surface text-on-surface-muted shadow-[var(--shadow-panel-card),var(--shadow-specular)] dark:bg-surface-container-high'

type CreateButtonProps = Omit<ComponentPropsWithRef<typeof IconButton>, 'name' | 'size' | 'variant'>

/**
 * 「+」新建按钮（顶栏与收起竖轨共用）：悬停切换为浮起白卡，菜单展开时进一步加深投影并显示外圈描边。
 * 其余属性透传至底层按钮（用作菜单触发器时由菜单组件注入状态属性）。
 */
export function CreateButton({ className, ...props }: CreateButtonProps) {
  return (
    <IconButton
      className={cn(
        CREATE_CHIP_CLASS,
        NO_HOVER_WASH_CLASS,
        // 深色静止底色通过 dark: 声明，悬停与展开态需同样声明 dark: 以保证更高优先级不被静止态覆盖
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

/** 正在新建 `label` 时替代「+」按钮：保持原有外观并将图标切换为加载动画；不可交互，无障碍名称为「正在新建 <label>」。 */
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

/** 页签栏右侧的新建菜单触发器：点击展开可新建的产物列表，创建进行中切换为加载指示器。 */
export function CreateMenu({ entries, creating, onCreate }: CreateMenuProps) {
  const pending = entries.find((entry) => entry.type === creating)
  if (pending !== undefined) return <CreatingMark label={pending.label} />
  return (
    // 关闭模态拦截：菜单展开期间点击页签可直接完成切换并收起菜单
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
            <span className="mr-2 inline-grid size-6.5 place-items-center rounded-sm bg-surface align-middle ring-1 ring-panel-line-strong ring-inset">
              <Icon className="text-tone-copper" decorative name={entry.icon} size="md" />
            </span>
            {entry.label}
          </MenuItem>
        ))}
      </MenuSurface>
    </MenuRoot>
  )
}
