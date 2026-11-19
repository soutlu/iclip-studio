/** 可选的角色，从低到高；菜单按这个顺序列出。 */
export const ROLE_OPTIONS = [
  { label: '只读', value: 'viewer' },
  { label: '编辑', value: 'editor' },
  { label: '管理员', value: 'admin' },
  { label: 'root', value: 'root' },
] as const

/** 用户的角色里排得最高的那个；一个都不认识时为 `null`。 */
export const highestRole = (roles: readonly string[]): string | null =>
  ROLE_OPTIONS.findLast((option) => roles.includes(option.value))?.value ?? null
