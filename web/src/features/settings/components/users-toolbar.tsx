import { useRef } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { ROLE_FILTERS } from '../roles'
import { RAISED_CLASS } from './settings-surface'

type UsersToolbarProps = {
  query: string
  onQueryChange: (query: string) => void
}

/** 控制栏：左边按角色筛选的分段（外层 `TabsRoot` 管选中值），右边搜索框占满剩下的宽度，放不下时换到下一行。 */
export function UsersToolbar({ onQueryChange, query }: UsersToolbarProps) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2.5">
      {/* 深色下这条槽坐在更深的托盘上，槽底再压一档才看得出凹 */}
      <TabsList aria-label="按角色筛选" className="dark:bg-control-well" variant="segmented">
        {ROLE_FILTERS.map((filter) => (
          <TabsTrigger key={filter.value} value={filter.value}>
            {filter.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <SearchField onChange={onQueryChange} value={query} />
    </div>
  )
}

function SearchField({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <label
      className={cn(
        RAISED_CLASS,
        'flex h-8 min-w-50 flex-1 items-center gap-2 rounded-control px-3 focus-within:ring-1 focus-within:ring-on-surface',
      )}
    >
      <Icon className="shrink-0 text-on-surface-faint" decorative name="search" size="sm" />
      <input
        aria-label="搜索用户"
        // 外框的墨色细线就是焦点指示；浏览器自带的清除按钮藏起来，只留下面这一个 ×
        className="field-nested-input h-full min-w-0 flex-1 bg-transparent text-ui text-on-surface placeholder:text-on-surface-faint [&::-webkit-search-cancel-button]:appearance-none"
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="搜索姓名、用户名、邮箱或部门"
        ref={inputRef}
        type="search"
        value={value}
      />
      {value ? (
        <button
          aria-label="清除搜索"
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-xs text-on-surface-faint ui-focus transition-colors ui-motion-s hover:text-on-surface"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          type="button"
        >
          <Icon decorative name="close" size="xs" />
        </button>
      ) : null}
    </label>
  )
}
