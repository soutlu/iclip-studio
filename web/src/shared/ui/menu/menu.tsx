import { ContextMenu, DropdownMenu } from 'radix-ui'
import type { ComponentProps, ComponentPropsWithoutRef, ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { POPUP_SURFACE_CLASS } from '@/shared/ui/popup'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

export const MenuRoot = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger
export const MenuRadioGroup = DropdownMenu.RadioGroup

/** 本身没有外观的菜单项：配合 `asChild` 把一个按钮放进菜单的方向键导航。 */
export const MenuBareItem = DropdownMenu.Item

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

type MenuSurfaceProps = ComponentPropsWithoutRef<typeof DropdownMenu.Content> & {
  /** 菜单挂到哪个元素里；不给就挂到 body。全屏时要挂进全屏的元素才看得见。 */
  container?: HTMLElement | null
}

export function MenuSurface({
  className,
  container = null,
  sideOffset = 4,
  ...props
}: MenuSurfaceProps) {
  return (
    <DropdownMenu.Portal container={container}>
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
  trailing?: ReactNode
}

export function MenuItem({
  children,
  className,
  destructive = false,
  icon,
  shortcut,
  trailing,
  ...props
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={cn(ITEM_CLASS, destructive ? 'text-error' : 'text-on-surface', className)}
      {...props}
    >
      {icon ? (
        <Icon
          className={cn('shrink-0', !destructive && 'text-on-surface-variant')}
          decorative
          name={icon}
          size="sm"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing === undefined ? null : (
        <span className="ml-4 flex shrink-0 items-center text-label text-on-surface-variant tabular-nums">
          {trailing}
        </span>
      )}
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

/** 右键菜单：样子和下拉菜单一样，在点右键的地方打开。把触发它的元素包在 `ContextMenuTrigger asChild` 里。 */
export const ContextMenuRoot = ContextMenu.Root
export const ContextMenuTrigger = ContextMenu.Trigger

export function ContextMenuSurface({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenu.Content>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        className={cn(POPUP_SURFACE_CLASS, 'flex min-w-36 flex-col gap-0.5 p-1', className)}
        {...props}
      />
    </ContextMenu.Portal>
  )
}

export function ContextMenuItem({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenu.Item>) {
  return (
    <ContextMenu.Item
      className={cn(
        ITEM_CLASS,
        'text-on-surface data-[disabled]:cursor-default data-[disabled]:opacity-(--state-disabled-content)',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenu.Item>
  )
}

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
  label: string
}

export function MenuIconRadioItem({
  className,
  icon,
  label,
  onSelect,
  ...props
}: MenuIconRadioItemProps) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild onFocus={(event) => event.preventDefault()}>
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
