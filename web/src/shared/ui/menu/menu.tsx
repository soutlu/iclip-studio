import { DropdownMenu } from 'radix-ui'
import type { ComponentProps, ComponentPropsWithoutRef } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { POPUP_SURFACE_CLASS } from '@/shared/ui/popup'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

export const MenuRoot = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger
export const MenuRadioGroup = DropdownMenu.RadioGroup

const ITEM_CLASS =
  // design-allow -- Radix 用 .focus() 移动高亮，浏览器默认框会和 ui-focus 的焦点环叠一起
  'ui-state ui-focus flex h-(--control-height-sm) cursor-pointer items-center gap-2 rounded-sm px-2 text-body outline-none select-none'

export function MenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator className={cn('mx-2 my-1 h-px bg-hairline', className)} {...props} />
  )
}

export function MenuSurface({
  className,
  sideOffset = 4,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={cn(POPUP_SURFACE_CLASS, 'flex min-w-36 flex-col gap-0.5 p-1', className)}
        sideOffset={sideOffset}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

type MenuItemProps = ComponentPropsWithoutRef<typeof DropdownMenu.Item> & {
  destructive?: boolean
  icon?: Parameters<typeof Icon>[0]['name']
  shortcut?: readonly string[]
}

export function MenuItem({
  children,
  className,
  destructive = false,
  icon,
  shortcut,
  ...props
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={cn(ITEM_CLASS, destructive ? 'text-error' : 'text-on-surface', className)}
      {...props}
    >
      {icon ? (
        // 危险项的图标沿用文字色，禁用时随 ui-state 一起变淡。
        <Icon
          className={cn('shrink-0', !destructive && 'text-on-surface-variant')}
          decorative
          name={icon}
          size="sm"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut?.length ? (
        <span className="ml-4 flex shrink-0 items-center gap-1 text-label text-on-surface-variant">
          {shortcut.map((key) => (
            <span key={key}>{key}</span>
          ))}
        </span>
      ) : null}
    </DropdownMenu.Item>
  )
}

/** `ref` 透传到菜单项，调用方可在打开后把焦点放到指定项上。 */
export function MenuRadioItem({
  children,
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem
      className={cn(ITEM_CLASS, 'justify-between text-on-surface', className)}
      {...props}
    >
      {children}
      {/* 选中态用墨色：品牌绿只留给出片主按钮与状态色。 */}
      <DropdownMenu.ItemIndicator asChild>
        <Icon className="text-on-surface" decorative name="check" size="md" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  )
}

const ICON_ITEM_CLASS =
  // design-allow -- Radix 用 .focus() 移动高亮，浏览器默认框会和 ui-focus 的焦点环叠一起
  'ui-state ui-focus grid h-6.5 w-7.5 shrink-0 cursor-pointer place-items-center rounded-sm text-on-surface-variant outline-none select-none data-[state=checked]:bg-state-active data-[state=checked]:text-on-surface'

type MenuIconRadioItemProps = Omit<ComponentProps<typeof DropdownMenu.RadioItem>, 'children'> & {
  icon: IconName
  /** 读屏用的名字，也是鼠标悬停时的提示。 */
  label: string
}

/**
 * 只有图标的单选项，几个横排在菜单的一行里（如外观的三档）。选中的一层浅墨底，与侧栏任务筛选的选中项同款。
 *
 * 选了菜单不关：换完马上看得到效果，也能接着换。提示只在鼠标悬停时弹出：键盘移动高亮时也弹的话，
 * Esc 要先关提示、再按一次才关菜单；键盘与读屏靠可访问名称。
 */
export function MenuIconRadioItem({
  className,
  icon,
  label,
  onSelect,
  ...props
}: MenuIconRadioItemProps) {
  return (
    <TooltipRoot>
      <TooltipTrigger
        asChild
        // 菜单项自己的聚焦处理先跑完，这里再拦下提示的聚焦打开。
        onFocus={(event) => event.preventDefault()}
      >
        <DropdownMenu.RadioItem
          aria-label={label}
          className={cn(ICON_ITEM_CLASS, className)}
          onSelect={(event) => {
            onSelect?.(event)
            event.preventDefault()
          }}
          {...props}
        >
          <Icon decorative name={icon} size="sm" />
        </DropdownMenu.RadioItem>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </TooltipRoot>
  )
}
