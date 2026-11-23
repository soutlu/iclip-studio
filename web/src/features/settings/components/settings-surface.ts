import { NO_HOVER_WASH_CLASS } from '@/shared/workbench'

/** 弹窗托盘底色（托盘内小徽标与空态圆形底盘复用）；深色模式下低于卡片表面一档。 */
export const TRAY_SURFACE_CLASS = 'bg-surface-container-low dark:bg-surface'

/** 浮起白块表面（用于头部图标容器与搜索框，与分段控件选中项材质一致）。 */
export const RAISED_CLASS =
  'bg-card shadow-[var(--shadow-pill),var(--shadow-specular)] dark:bg-surface-container-high'

/**
 * 悬停抬升交互表面（关闭按钮与行内选择器共用）：静止态透明，悬停抬升为白块，菜单展开态进一步加深投影并显示外圈描边。
 * 悬停不叠加灰底；深色模式需在 hover / open 状态分别声明 `dark:`，避免被浅色 `bg-card` 覆盖。
 */
export const RAISE_ON_HOVER_CLASS = [
  'ui-state',
  NO_HOVER_WASH_CLASS,
  'enabled:hover:bg-card enabled:hover:shadow-[var(--shadow-pill),var(--shadow-specular)] dark:enabled:hover:bg-surface-container-high',
  'data-[state=open]:bg-card data-[state=open]:shadow-[var(--shadow-panel),0_0_0_1px_var(--color-panel-line-strong),var(--shadow-specular)] dark:data-[state=open]:bg-surface-container-high',
].join(' ')

/**
 * 成员表头与数据行共用的网格布局：成员、角色、配置组三列。窄屏下隐藏表头，每条记录折为两行：
 * 第一行为成员信息（跨两列），第二行为角色与配置组（角色格左缩进 48px，列宽计入该缩进以确保各行配置组列对齐）。
 */
export const MEMBER_GRID_CLASS =
  'grid grid-cols-[minmax(0,1fr)_122px_140px] items-center gap-x-4 px-5 max-sm:grid-cols-[152px_minmax(0,1fr)] max-sm:gap-y-1'
