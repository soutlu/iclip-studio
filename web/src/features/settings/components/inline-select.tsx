import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioGroup, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger, useTabTooltip } from '@/shared/ui/tooltip'
import { NO_HOVER_WASH_CLASS } from '@/shared/workbench'
import { RAISE_ON_HOVER_CLASS } from './settings-surface'

// 可编辑、只读与失效警示单元格共用的基础几何样式：左右内边距 10px 并以等量负左外边距抵消，
// 使内部色点与文本左缘与表头列名对齐。
const CELL_CLASS =
  'inline-flex h-7.5 max-w-[calc(100%+10px)] min-w-0 -ml-2.5 items-center gap-1.5 rounded-sm px-2.5 text-ui ui-focus'

const WARNING_TRIGGER_CLASS = [
  'ui-state',
  NO_HOVER_WASH_CLASS,
  'bg-warning/10 font-medium text-warning ring-1 ring-warning/25 ring-inset',
  'enabled:hover:bg-warning/15 enabled:hover:ring-warning data-[state=open]:bg-warning/15 data-[state=open]:ring-warning',
].join(' ')

type InlineSelectProps = {
  /** 触发按钮的无障碍名称，须包含当前值（如「小王的角色：管理员」）。 */
  label: string
  /** 触发按钮内展示的当前值（色点、图标、文本）；尾部展开箭头由组件统一渲染。 */
  face: ReactNode
  value: string
  onChange: (value: string) => void
  /** 下拉菜单中的单选项列表（`MenuRadioItem`）。 */
  children: ReactNode
  /** 单选项下方的附加内容（如配置组失效提示）。 */
  footer?: ReactNode
  /** 下拉菜单的宽度样式类。 */
  menuClassName: string
  /** 是否禁用交互（例如保存请求进行中）。 */
  disabled: boolean
  /** 当前值异常时启用警示态外观。 */
  warning?: boolean
}

/** 成员表行内单选控件：静止态仅展示文本与展开箭头，悬停抬升为白块，点击后左对齐展开单选菜单。 */
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
 * 不可编辑的成员表单元格：外观呈静态文本（无展开箭头与悬停抬升），仍保留可聚焦按钮语义，悬停或键盘聚焦时通过 Tooltip 说明不可编辑原因。
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
        {/* 使用 aria-disabled 而非 disabled，保持悬停与键盘聚焦能力以展示不可编辑原因 */}
        <button aria-disabled="true" aria-label={label} className={CELL_CLASS} type="button">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </TooltipRoot>
  )
}
