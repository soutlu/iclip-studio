import { errorMessageOf } from '@/shared/api/client'
import { toast } from '@/shared/ui/toast'
import { UserAvatar } from '@/shared/ui/user-avatar'
import { highestRole, ROLE_OPTIONS } from '../roles'
import { useSetUserModelGroup, useSetUserRole, type ManagedUser } from '../users.api'
import { OptionPicker } from './option-picker'

// 菜单里「默认组」项的值；组名以小写字母开头，不会和它撞上
const DEFAULT_GROUP = ''

type UserRowProps = {
  user: ManagedUser
  isSelf: boolean
  /** 部署配置里的组名，按配置顺序。 */
  groups: readonly string[]
}

export function UserRow({ groups, isSelf, user }: UserRowProps) {
  const name = user.displayName || user.username || user.email
  const departments = user.departments.map((department) => department.name).join('、')
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <UserAvatar avatarUrl={user.avatarUrl} name={name} />
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-on-surface">{name}</p>
          <p className="truncate text-body-sm text-on-surface-variant">
            {[departments, user.email].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <RolePicker isSelf={isSelf} name={name} user={user} />
        <GroupPicker groups={groups} name={name} user={user} />
      </div>
    </li>
  )
}

function RolePicker({ isSelf, name, user }: { isSelf: boolean; name: string; user: ManagedUser }) {
  const mutation = useSetUserRole()
  // 保存期间先显示刚选的；失败后 isPending 落下，自然回到保存前的角色
  const value = mutation.isPending ? mutation.variables.role : (highestRole(user.roles) ?? '')
  return (
    <OptionPicker
      disabled={mutation.isPending}
      disabledReason={isSelf ? '无法修改自己的角色' : undefined}
      label={`${name}的角色`}
      onChange={(role) => {
        if (user.roles.length === 1 && user.roles[0] === role) return
        mutation.mutate(
          { role, userId: user.id },
          { onError: (error) => toast.error(errorMessageOf(error, '角色保存失败')) },
        )
      }}
      options={ROLE_OPTIONS}
      placeholder="未分配角色"
      value={value}
    />
  )
}

function GroupPicker({
  groups,
  name,
  user,
}: {
  groups: readonly string[]
  name: string
  user: ManagedUser
}) {
  const mutation = useSetUserModelGroup()
  const saved = user.modelGroup
  // 存的组已不在部署配置里时也列出来，才看得出他在哪、能把他挪走
  const names = saved === null || groups.includes(saved) ? groups : [...groups, saved]
  const shown = mutation.isPending ? mutation.variables.modelGroup : saved
  return (
    <OptionPicker
      disabled={mutation.isPending || names.length === 0}
      label={`${name}的配置组`}
      onChange={(picked) => {
        const modelGroup = picked === DEFAULT_GROUP ? null : picked
        if (modelGroup === saved) return
        mutation.mutate(
          { modelGroup, userId: user.id },
          { onError: (error) => toast.error(errorMessageOf(error, '配置组保存失败')) },
        )
      }}
      options={[
        { label: '默认组', value: DEFAULT_GROUP },
        ...names.map((group) => ({ label: group, value: group })),
      ]}
      placeholder="默认组"
      value={shown ?? DEFAULT_GROUP}
    />
  )
}
