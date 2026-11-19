import { useId, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useModelGroups } from '@/shared/api/model-groups'
import { useUser } from '@/shared/auth'
import { Input } from '@/shared/ui/field'
import { ListEmpty, ListError, ListPending } from '@/shared/ui/list-state'
import { useAllUsers, type ManagedUser } from '../users.api'
import { UserRow } from './user-row'

const searchText = (user: ManagedUser) =>
  [
    user.displayName,
    user.username ?? '',
    user.email,
    ...user.departments.map((department) => department.name),
  ]
    .join(' ')
    .toLowerCase()

/** 「用户」分区：搜索框固定在上面，下面的用户列表在分区里滚动。 */
export function UsersSection() {
  const titleId = useId()
  const [query, setQuery] = useState('')
  return (
    <section aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-3 px-6 pt-5 pb-3">
        <div>
          <h3 className="text-title font-semibold text-on-surface" id={titleId}>
            用户
          </h3>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            为成员设置角色和配置组，修改后立即生效
          </p>
        </div>
        <Input
          aria-label="搜索用户"
          leadingIcon="search"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索姓名、用户名、邮箱或部门"
          type="search"
          value={query}
          wrapperClassName="h-(--control-height-md) rounded-sm"
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <UserList keyword={query.trim().toLowerCase()} />
      </div>
    </section>
  )
}

function UserList({ keyword }: { keyword: string }) {
  const me = useUser().data
  const users = useAllUsers()
  const groups = useModelGroups()

  if (users.isPending || groups.isPending) return <ListPending label="正在读取用户…" />
  if (users.isError || groups.isError) {
    return (
      <ListError
        message={errorMessageOf(users.error ?? groups.error, '读取用户失败')}
        onRetry={() => {
          if (users.isError) void users.refetch()
          if (groups.isError) void groups.refetch()
        }}
      />
    )
  }

  const matches = users.data.filter((user) => searchText(user).includes(keyword))
  if (matches.length === 0) return <ListEmpty>没有匹配的用户</ListEmpty>
  return (
    <ul aria-label="用户列表" className="divide-y divide-hairline">
      {matches.map((user) => (
        <UserRow groups={groups.data} isSelf={user.id === me?.id} key={user.id} user={user} />
      ))}
    </ul>
  )
}
