/**
 * 可分配角色定义（按权限从低到高排列，下拉菜单沿用此顺序）。`dotClass` 指定角色圆点颜色，`description` 为菜单项副标题。
 * `root` 使用墨色而非品牌绿（品牌绿仅用于「生成」主操作与成功状态）。
 */
export const ROLE_OPTIONS = [
  {
    description: '仅查看对话、需求单与资料库',
    dotClass: 'bg-outline',
    label: '只读',
    value: 'viewer',
  },
  {
    description: '发起创作、生成图片与视频',
    dotClass: 'bg-tone-teal',
    label: '编辑',
    value: 'editor',
  },
  {
    description: '审计全部对话、管理资料库标签',
    dotClass: 'bg-tone-slate',
    label: '管理员',
    value: 'admin',
  },
  { description: '全部系统与配置权限', dotClass: 'bg-on-surface', label: 'root', value: 'root' },
] as const

export type RoleOption = (typeof ROLE_OPTIONS)[number]

/** 角色筛选分段项：首项为「全部」，其余按权限从高到低排列。 */
export const ROLE_FILTERS = [
  { label: '全部', value: 'all' },
  ...ROLE_OPTIONS.toReversed().map(({ label, value }) => ({ label, value })),
] as const

/** 返回用户角色列表中权限最高的已知角色；无匹配时返回 `null`。 */
export const highestRole = (roles: readonly string[]): string | null =>
  ROLE_OPTIONS.findLast((option) => roles.includes(option.value))?.value ?? null
