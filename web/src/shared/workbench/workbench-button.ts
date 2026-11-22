/** 工作台顶栏右边和收起竖条里的图标按钮（`IconButton size="sm"` 上加）：30×30、控件圆角、淡色图标，悬停时图标变深。 */
export const WORKBENCH_BUTTON_CLASS =
  'size-7.5 shrink-0 rounded-control text-on-surface-muted hover:text-on-surface'

/**
 * 和 ui-state 一起用在白色浮起面（白卡、选中的白块）上：悬停不叠灰，改由各自的底色或投影表达；按下、禁用照旧归 ui-state。
 */
export const NO_HOVER_WASH_CLASS = '[--color-state-hover:transparent]'

/** 浮起的白色小卡（空态卡片的新建行、文件页的「打开 X」）悬停时更浮起：投影加深、外圈细线变实。和 ui-state 一起用。 */
export const RAISED_CARD_HOVER_CLASS = `${NO_HOVER_WASH_CLASS} hover:shadow-[var(--shadow-panel),0_0_0_1px_var(--color-panel-line-strong),var(--shadow-specular)]`
