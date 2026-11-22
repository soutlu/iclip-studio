import { useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useModelGroups } from '@/shared/api/model-groups'
import { useUser } from '@/shared/auth'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { TabsRoot } from '@/shared/ui/tabs'
import { highestRole } from '../roles'
import { useAllUsers, type ManagedUser } from '../users.api'
import { MemberTable, NoMatch } from './member-table'
import { UserRow } from './user-row'
import { UsersToolbar } from './users-toolbar'

const ALL_ROLES = 'all'

const searchText = (user: ManagedUser) =>
  [
    user.displayName,
    user.username ?? '',
    user.email,
    ...user.departments.map((department) => department.name),
  ]
    .join(' ')
    .toLowerCase()

/**
 * 「用户」分区：控制栏（按角色筛选、搜索）、成员表白卡、底栏人数。分区名是弹窗头部的「用户」（`labelledBy`）。
 * 两个筛选条件同时生效：角色看每人最高的那个角色，搜索按显示名、用户名、邮箱、部门名，不分大小写。
 */
export function UsersSection({ labelledBy }: { labelledBy: string }) {
  const me = useUser().data
  const users = useAllUsers()
  const groups = useModelGroups()
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<string>(ALL_ROLES)
  const keyword = query.trim().toLowerCase()
  const filtering = keyword !== '' || role !== ALL_ROLES

  let body: ReactNode
  let summary: string | null = null
  if (users.isPending || groups.isPending) {
    body = (
      <Centered>
        <ListPending label="正在读取用户…" />
      </Centered>
    )
  } else if (users.isError || groups.isError) {
    body = (
      <Centered>
        <ListError
          message={errorMessageOf(users.error ?? groups.error, '读取用户失败')}
          onRetry={() => {
            if (users.isError) void users.refetch()
            if (groups.isError) void groups.refetch()
          }}
        />
      </Centered>
    )
  } else {
    const matches = users.data.filter(
      (user) =>
        (role === ALL_ROLES || highestRole(user.roles) === role) &&
        searchText(user).includes(keyword),
    )
    const total = users.data.length
    summary = [
      filtering ? `显示 ${matches.length} / ${total} 位成员` : `共 ${total} 位成员`,
      groups.data.length > 0 ? `${groups.data.length} 个配置组` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    body =
      matches.length === 0 ? (
        <NoMatch
          onClear={
            filtering
              ? () => {
                  setQuery('')
                  setRole(ALL_ROLES)
                }
              : undefined
          }
        />
      ) : (
        <ul aria-label="用户列表">
          {matches.map((user) => (
            <UserRow groups={groups.data} isSelf={user.id === me?.id} key={user.id} user={user} />
          ))}
        </ul>
      )
  }

  return (
    <TabsRoot asChild onValueChange={setRole} value={role}>
      <section aria-labelledby={labelledBy} className="flex min-h-0 flex-1 flex-col gap-3.5">
        <UsersToolbar onQueryChange={setQuery} query={query} />
        <MemberTable value={role}>{body}</MemberTable>
        <UsersFooter summary={summary} />
      </section>
    </TabsRoot>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="m-auto">{children}</div>
}

/** 底栏：左边人数（读取中、读取失败时不显示），右边「即时生效」。 */
function UsersFooter({ summary }: { summary: string | null }) {
  return (
    <footer className="flex shrink-0 items-center justify-between gap-4 text-label text-on-surface-faint tabular-nums">
      <span>{summary}</span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
        即时生效
      </span>
    </footer>
  )
}
