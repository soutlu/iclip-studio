import { useId } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuRadioItem, MenuSeparator } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { UserAvatar } from '@/shared/ui/user-avatar'
import { highestRole, ROLE_OPTIONS, type RoleOption } from '../roles'
import { useSetUserModelGroup, useSetUserRole, type ManagedUser } from '../users.api'
import { FixedCell, InlineSelect } from './inline-select'
import { MEMBER_GRID_CLASS, TRAY_SURFACE_CLASS } from './settings-surface'

// 下拉菜单中「默认组」选项的哨兵值（后端配置组名以小写字母开头，不会冲突）
const DEFAULT_GROUP = ''

// 无头像图片时，按用户 ID 哈希稳定映射到其中一档首字色调（首档沿用头像默认中性灰）
const AVATAR_TONES = [
  '',
  'bg-tone-slate/10 text-tone-slate ring-1 ring-tone-slate/15 ring-inset',
  'bg-tone-teal/10 text-tone-teal ring-1 ring-tone-teal/15 ring-inset',
  'bg-tone-umber/10 text-tone-umber ring-1 ring-tone-umber/15 ring-inset',
] as const

const avatarToneOf = (userId: string) => {
  const sum = userId.split('').reduce((total, char) => total + char.charCodeAt(0), 0)
  return AVATAR_TONES[sum % AVATAR_TONES.length]
}

type UserRowProps = {
  user: ManagedUser
  isSelf: boolean
  /** 部署配置中定义的配置组名称列表（按配置顺序）。 */
  groups: readonly string[]
}

export function UserRow({ groups, isSelf, user }: UserRowProps) {
  const name = user.displayName || user.username || user.email
  const departments = user.departments.map((department) => department.name).join('、')
  // 显示名称与邮箱相同时不再重复展示邮箱
  const email = name.toLowerCase() === user.email.toLowerCase() ? '' : user.email
  const detail = [departments, email].filter(Boolean).join(' · ')
  const hasPhoto = user.avatarUrl.trim() !== ''
  return (
    <li
      className={cn(
        MEMBER_GRID_CLASS,
        'border-b border-panel-line py-3 last:border-b-0 hover:bg-state-hover',
      )}
    >
      <div className="flex min-w-0 items-center gap-3 max-sm:col-span-2">
        <UserAvatar
          avatarUrl={user.avatarUrl}
          className={cn('size-9 text-ui font-medium', !hasPhoto && avatarToneOf(user.id))}
          name={name}
        />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-on-surface">{name}</span>
            {isSelf ? (
              <span
                className={cn(
                  TRAY_SURFACE_CLASS,
                  'inline-flex h-4.5 shrink-0 items-center rounded-xs px-1.5 text-caption font-medium text-on-surface-variant ring-1 ring-panel-line ring-inset',
                )}
              >
                我
              </span>
            ) : null}
          </p>
          {detail ? <p className="truncate text-body-sm text-on-surface-faint">{detail}</p> : null}
        </div>
      </div>
      {/* 窄屏折至第二行时缩进头像宽度与间距之和（48px），与上方姓名左缘对齐 */}
      <div className="min-w-0 max-sm:pl-12">
        <RolePicker isSelf={isSelf} name={name} user={user} />
      </div>
      <div className="min-w-0">
        <GroupPicker groups={groups} name={name} user={user} />
      </div>
    </li>
  )
}

function RoleDot({ role }: { role: RoleOption }) {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', role.dotClass)} />
}

function RolePicker({ isSelf, name, user }: { isSelf: boolean; name: string; user: ManagedUser }) {
  const mutation = useSetUserRole()
  // 保存请求进行中乐观展示所选角色；失败后 isPending 复位，自动回退至已保存值
  const value = mutation.isPending ? mutation.variables.role : (highestRole(user.roles) ?? '')
  const role = ROLE_OPTIONS.find((option) => option.value === value)
  const shown = role?.label ?? '未分配角色'
  const label = `${name}的角色：${shown}`
  const face = (
    <>
      {role ? <RoleDot role={role} /> : null}
      <span className="min-w-0 truncate">{shown}</span>
    </>
  )

  if (isSelf) {
    return (
      <FixedCell label={label} reason="无法修改自己的角色">
        {face}
        <Icon
          className="size-2.75 shrink-0 text-on-surface-faint opacity-50"
          decorative
          name="locked"
        />
      </FixedCell>
    )
  }

  return (
    <InlineSelect
      disabled={mutation.isPending}
      face={face}
      label={label}
      menuClassName="w-62"
      onChange={(picked) => {
        if (user.roles.length === 1 && user.roles[0] === picked) return
        mutation.mutate(
          { role: picked, userId: user.id },
          { onError: (error) => toast.error(errorMessageOf(error, '角色保存失败')) },
        )
      }}
      value={value}
    >
      {ROLE_OPTIONS.map((option) => (
        <RoleItem key={option.value} role={option} />
      ))}
    </InlineSelect>
  )
}

/** 角色单选菜单项：分两行展示角色名称与权限说明；无障碍名称仅包含角色名，说明通过 `aria-describedby` 关联。 */
function RoleItem({ role }: { role: RoleOption }) {
  const descriptionId = useId()
  return (
    <MenuRadioItem
      aria-describedby={descriptionId}
      aria-label={role.label}
      className="h-auto items-start py-2"
      value={role.value}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-ui font-medium">
          <RoleDot role={role} />
          {role.label}
        </span>
        <span className="mt-0.5 block pl-3.5 text-label text-on-surface-faint" id={descriptionId}>
          {role.description}
        </span>
      </span>
    </MenuRadioItem>
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
  const shown = mutation.isPending ? mutation.variables.modelGroup : saved
  // 已保存的配置组不在当前部署配置中：保留展示并标示警示态，菜单仅列出现有配置组以引导切换
  const stale = shown !== null && !groups.includes(shown)

  if (groups.length === 0 && !stale) {
    return (
      <FixedCell label={`${name}的配置组：默认组`} reason="当前未配置其他配置组">
        <span className="text-on-surface-faint">默认组</span>
      </FixedCell>
    )
  }

  return (
    <InlineSelect
      disabled={mutation.isPending}
      face={
        <>
          {stale ? <Icon className="size-3.25 shrink-0" decorative name="alert" /> : null}
          <span className={cn('min-w-0 truncate', shown === null && 'text-on-surface-variant')}>
            {shown ?? '默认组'}
          </span>
        </>
      }
      footer={
        stale ? (
          <>
            <MenuSeparator />
            {/* 优先在标点处折行，避免拆分「请切换」；配置组名称过长时仍允许词内断行 */}
            <p className="px-2 py-1.5 text-label break-words break-keep text-warning">
              原配置组「{shown}」已失效；请切换
            </p>
          </>
        ) : null
      }
      label={`${name}的配置组：${shown ?? '默认组'}${stale ? '（已失效）' : ''}`}
      menuClassName="w-48"
      onChange={(picked) => {
        const modelGroup = picked === DEFAULT_GROUP ? null : picked
        if (modelGroup === saved) return
        mutation.mutate(
          { modelGroup, userId: user.id },
          { onError: (error) => toast.error(errorMessageOf(error, '配置组保存失败')) },
        )
      }}
      value={shown ?? DEFAULT_GROUP}
      warning={stale}
    >
      {[
        { label: '默认组', value: DEFAULT_GROUP },
        ...groups.map((group) => ({ label: group, value: group })),
      ].map((option) => (
        <MenuRadioItem className="text-ui" key={option.value} value={option.value}>
          <span className="min-w-0 truncate">{option.label}</span>
        </MenuRadioItem>
      ))}
    </InlineSelect>
  )
}
