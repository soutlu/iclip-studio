import type { Permission as ContractPermission } from '@/shared/api/generated/types.gen'

export const PERMISSION = {
  agentManage: 'agent:manage',
  agentRead: 'agent:read',
  agentRun: 'agent:run',
  collectionsRead: 'collections:read',
  collectionsWrite: 'collections:write',
  generationRead: 'generation:read',
  generationSubmit: 'generation:submit',
  inspirationsRead: 'inspirations:read',
  libraryTagsManage: 'library_tags:manage',
  modelManage: 'model:manage',
  tasksRead: 'tasks:read',
  tasksWrite: 'tasks:write',
  uploadsWrite: 'uploads:write',
  usersManage: 'users:manage',
} as const satisfies Record<string, ContractPermission>

export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION]

type PermissionHolder = { permissions: readonly string[] } | null | undefined

export const hasPermission = (user: PermissionHolder, permission: Permission): boolean =>
  user?.permissions.includes(permission) ?? false

export const canAuditAll = (user: PermissionHolder): boolean =>
  hasPermission(user, PERMISSION.usersManage) && hasPermission(user, PERMISSION.agentRead)

/** 「设置 → 用户」：读用户、改角色要 `users:manage`，选配置组要 `model:manage`。 */
export const canManageMembers = (user: PermissionHolder): boolean =>
  hasPermission(user, PERMISSION.usersManage) && hasPermission(user, PERMISSION.modelManage)
