/**
 * 可选的角色，从低到高；菜单按这个顺序列出。`dotClass` 是角色色点的底色，`description` 是菜单里角色名下面的说明。
 * root 用墨色而不是品牌绿：品牌绿只留给「生成」和完成状态。
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

/** 按角色筛选的分段：先「全部」，再从高到低列出每个角色。 */
export const ROLE_FILTERS = [
  { label: '全部', value: 'all' },
  ...ROLE_OPTIONS.toReversed().map(({ label, value }) => ({ label, value })),
] as const

/** 用户的角色里排得最高的那个；一个都不认识时为 `null`。 */
export const highestRole = (roles: readonly string[]): string | null =>
  ROLE_OPTIONS.findLast((option) => roles.includes(option.value))?.value ?? null
