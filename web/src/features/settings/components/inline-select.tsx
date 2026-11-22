import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioGroup, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'
import { NO_HOVER_WASH_CLASS } from '@/shared/workbench'
import { RAISE_ON_HOVER_CLASS } from './settings-surface'

// 能改的、不能改的、失效警示三种格子共用的外形。左右各留 10 的内边距，再用等量的负外边距拉回去，
// 里面的色点和文字才和表头的列名落在同一条竖线上
const CELL_CLASS =
  'inline-flex h-7.5 max-w-[calc(100%+10px)] min-w-0 -ml-2.5 items-center gap-1.5 rounded-sm px-2.5 text-ui ui-focus'

const WARNING_TRIGGER_CLASS = [
  'ui-state',
  NO_HOVER_WASH_CLASS,
  'bg-warning/10 font-medium text-warning ring-1 ring-warning/25 ring-inset',
  'enabled:hover:bg-warning/15 enabled:hover:ring-warning data-[state=open]:bg-warning/15 data-[state=open]:ring-warning',
].join(' ')

type InlineSelectProps = {
  /** 触发按钮的无障碍名称，写全当前值，例如「小王的角色：管理员」。 */
  label: string
  /** 触发按钮上显示的当前值（色点、图标、文字）；后面的 ⌄ 由这里加。 */
  face: ReactNode
  value: string
  onChange: (value: string) => void
  /** 菜单里的单选项（`MenuRadioItem`）。 */
  children: ReactNode
  /** 单选项下面的附加内容，例如失效说明。 */
  footer?: ReactNode
  /** 菜单的宽度类。 */
  menuClassName: string
  /** 正在保存，暂时不能点。 */
  disabled: boolean
  /** 当前值有问题：触发按钮换成警示样子。 */
  warning?: boolean
}

/** 成员表里的行内选择：静止时只是文字和 ⌄，悬停浮起成白色小块，点开是左边缘对齐它的单选菜单。 */
export function InlineSelect({
  children,
  disabled,
  face,
  footer,
  label,
  menuClassName,
  onChange,
  value,
  warning = false,
}: InlineSelectProps) {
  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={label}
        className={cn(
          CELL_CLASS,
          'group/select cursor-pointer',
          warning ? WARNING_TRIGGER_CLASS : [RAISE_ON_HOVER_CLASS, 'text-on-surface'],
        )}
        disabled={disabled}
      >
        {face}
        <Icon
          className={cn(
            'size-3.25 shrink-0 transition-[color,rotate] ui-motion-s group-data-[state=open]/select:rotate-180',
            warning
              ? 'text-warning'
              : 'text-on-surface-faint group-hover/select:text-on-surface group-data-[state=open]/select:text-on-surface',
          )}
          decorative
          name="expand"
        />
      </MenuTrigger>
      <MenuSurface align="start" className={menuClassName}>
        <MenuRadioGroup onValueChange={onChange} value={value}>
          {children}
        </MenuRadioGroup>
        {footer}
      </MenuSurface>
    </MenuRoot>
  )
}

/**
 * 不能改的格子：看起来是静态文字，不带 ⌄、悬停不浮起。仍是能聚焦的按钮，悬停或用 Tab 移上来时提示原因。
 */
export function FixedCell({
  children,
  label,
  reason,
}: {
  children: ReactNode
  label: string
  reason: string
}) {
  const { rootProps, triggerProps } = useTabTooltip()
  return (
    <TooltipRoot {...rootProps}>
      <TooltipTrigger asChild {...triggerProps}>
        {/* aria-disabled 而不是 disabled：按钮还要能悬停和聚焦，才看得到原因 */}
        <button aria-disabled="true" aria-label={label} className={CELL_CLASS} type="button">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </TooltipRoot>
  )
}
