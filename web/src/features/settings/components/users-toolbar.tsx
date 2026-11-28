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

/** 成员工具栏：左侧为角色筛选分段控件（受外层 `TabsRoot` 控制），右侧搜索框自适应剩余宽度，空间不足时折行排列。 */
export function UsersToolbar({ onQueryChange, query }: UsersToolbarProps) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2.5">
      <TabsList aria-label="按角色筛选" variant="segmented">
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
        // 焦点指示由外层容器的墨色描边承担；隐藏浏览器原生清除按钮，统一使用右侧自定义清除按钮
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
