// 单测与 dev:mock 共用的登录身份；单独成模块，transcript 与 handlers 两边的 mock 都能引用它而不成环。
// 权限词表直接引文件而不走 @/shared/auth 出口，免得把会话与 query client 拖进 mock。
import { PERMISSION } from '@/shared/auth/permissions'

// 接口回的是字符串数组，这里也按 string[] 存，其他测试身份可以追加权限。
const EDITOR_PERMISSIONS: string[] = [
  PERMISSION.agentRead,
  PERMISSION.agentRun,
  PERMISSION.generationRead,
  PERMISSION.generationSubmit,
  PERMISSION.inspirationsRead,
  PERMISSION.uploadsWrite,
  PERMISSION.collectionsRead,
  PERMISSION.collectionsWrite,
  PERMISSION.tasksRead,
  PERMISSION.tasksWrite,
]

export const mockAuthUser = {
  avatarUrl: '',
  city: '',
  createdAt: null,
  departments: [],
  directPermissions: [],
  displayName: '测试用户',
  email: 'tester@example.com',
  id: '0f7f4c1e-8a3b-4d0e-9c2a-6b1d2e3f4a5b',
  isActive: true,
  jobTitle: '',
  lastLoginAt: null,
  permissions: EDITOR_PERMISSIONS,
  roles: ['editor'],
  username: 'tester',
}

/** 治理者账号：用 governor 登录 mock 就是它，可以复盘全部对话、管理用户与标签。 */
export const mockGovernor = {
  ...mockAuthUser,
  displayName: '治理者',
  email: 'governor@example.com',
  id: '4b9d2e7a-1c3f-4a5b-8d6e-2f7a9c1b3d5e',
  permissions: [...mockAuthUser.permissions, PERMISSION.usersManage, PERMISSION.libraryTagsManage],
  roles: ['root'],
  username: 'governor',
}
