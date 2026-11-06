import { PERMISSION } from '@/shared/auth/permissions'

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

export const mockGovernor = {
  ...mockAuthUser,
  displayName: '治理者',
  email: 'governor@example.com',
  id: '4b9d2e7a-1c3f-4a5b-8d6e-2f7a9c1b3d5e',
  permissions: [
    ...mockAuthUser.permissions,
    PERMISSION.usersManage,
    PERMISSION.libraryTagsManage,
    PERMISSION.agentManage,
    PERMISSION.modelManage,
  ],
  roles: ['root'],
  username: 'governor',
}
