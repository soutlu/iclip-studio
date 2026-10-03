// 侧栏各行共用：36px 行高，容器内左右 10px。行首图标一律 16px（--icon-md）、与文字隔 10px：
// 图标、分区标题与无图标的标题共用同一左缘，行尾计数与状态图形右缘落在行内容右缘。
// 行的几何单独成一份，原位编辑行只取几何、不带悬停叠层，编辑时文字不移位。
export const SIDEBAR_ROW_BOX =
  'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-body text-on-surface'

// 状态层作用于整行及尾部按钮；内部标题按钮只负责焦点环。
export const SIDEBAR_ROW_CLASS = `group ui-state cursor-pointer ${SIDEBAR_ROW_BOX}`

export const SIDEBAR_ROW_TITLE_CLASS =
  'flex min-w-0 flex-1 items-center gap-2.5 rounded-xs ui-focus'

/** 选中行：浅灰侧栏上浮起的一枚胶囊；深色下 top-layer 是抬高一档的中性灰，不是纯白。 */
export const SIDEBAR_ROW_ACTIVE = 'bg-top-layer font-semibold shadow-[var(--shadow-1)]'

/** 行内 ⋯ 菜单打开时保持悬停底色；选中行保留自己的底色，不加这一层。 */
export const SIDEBAR_ROW_MENU_OPEN = 'has-data-[state=open]:bg-state-hover'

// 行尾的 ⋯ 排在状态与计数右边，出现时不顶掉它们。桌面上悬停、键盘焦点落进行里或菜单展开时才现身；
// 触屏没有悬停，⋯ 常驻并压成弱灰，不抢标题。
// ⋯ 平时只是视觉隐藏、始终留在 Tab 序里：鼠标点开对话后再按 Tab 也走得到它。
// 负右距挂在按钮上（not-sr-only 会清掉槽位自己的 margin），让 24px 按钮里的图标右缘落在行内容右缘。
export const SIDEBAR_ROW_TRAILING_SHOWN =
  'sr-only *:-mr-1.25 group-hover:not-sr-only group-hover:flex group-has-focus-visible:not-sr-only group-has-focus-visible:flex group-has-data-[state=open]:not-sr-only group-has-data-[state=open]:flex touch:not-sr-only touch:flex touch:*:text-on-surface-faint'
