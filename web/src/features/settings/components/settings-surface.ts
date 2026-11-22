import { NO_HOVER_WASH_CLASS } from '@/shared/workbench'

/** 弹窗底（托盘）的颜色；托盘上的小标记、空态圆底也用它。深色下托盘比白卡低一档。 */
export const TRAY_SURFACE_CLASS = 'bg-surface-container-low dark:bg-surface'

/** 浮起的白色小块：头部图标块、搜索框。和分段控件选中格同一种面。 */
export const RAISED_CLASS =
  'bg-card shadow-[var(--shadow-pill),var(--shadow-specular)] dark:bg-surface-container-high'

/**
 * 静止时没有底、悬停浮起成白色小块、菜单展开时浮得更高（投影加深、外圈一道实线），关闭按钮和行内选择共用。
 * 悬停不叠灰；深色的浮起底色要在 hover / open 上各写一遍 dark:，否则亮色的 bg-card 会盖过去。
 */
export const RAISE_ON_HOVER_CLASS = [
  'ui-state',
  NO_HOVER_WASH_CLASS,
  'enabled:hover:bg-card enabled:hover:shadow-[var(--shadow-pill),var(--shadow-specular)] dark:enabled:hover:bg-surface-container-high',
  'data-[state=open]:bg-card data-[state=open]:shadow-[var(--shadow-panel),0_0_0_1px_var(--color-panel-line-strong),var(--shadow-specular)] dark:data-[state=open]:bg-surface-container-high',
].join(' ')

/**
 * 成员表的表头和每一行共用的网格：成员、角色、配置组三列。窄屏没有表头，每行折成两行：
 * 成员占满第一行，角色和配置组排在第二行（角色格自己缩进 48，列宽含缩进，各行的配置组才对得齐）。
 */
export const MEMBER_GRID_CLASS =
  'grid grid-cols-[minmax(0,1fr)_122px_140px] items-center gap-x-4 px-5 max-sm:grid-cols-[152px_minmax(0,1fr)] max-sm:gap-y-1'
