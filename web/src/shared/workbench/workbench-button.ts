/** 工作台顶栏右侧与收起竖轨共用的图标按钮样式（叠加于 `IconButton size="sm"`）：30×30、控件圆角、次弱图标色，悬停加深。 */
export const WORKBENCH_BUTTON_CLASS =
  'size-7.5 shrink-0 rounded-control text-on-surface-muted hover:text-on-surface'

/**
 * 与 `ui-state` 配合用于白色浮起表面（白卡、选中项）：取消悬停灰底叠层，改由各自底色或投影表达悬停态；按下与禁用态仍由 `ui-state` 控制。
 */
export const NO_HOVER_WASH_CLASS = '[--color-state-hover:transparent]'

/** 浮起白卡控件（空态新建行、文件页「打开 X」按钮）的悬停抬升样式：加深投影并强化外圈描边，需与 `ui-state` 配合使用。 */
export const RAISED_CARD_HOVER_CLASS = `${NO_HOVER_WASH_CLASS} hover:shadow-[var(--shadow-panel),0_0_0_1px_var(--color-panel-line-strong),var(--shadow-specular)]`
