import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { Input } from '@/shared/ui/field'
import { TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { LIBRARY_TABS } from '../library-tabs'

const SEARCH_DEBOUNCE_MS = 300

export function LibraryTabsList() {
  return (
    <TabsList
      aria-label="资料库内容"
      className="h-10 shrink-0 gap-4 overflow-x-auto border-b border-hairline sm:gap-6"
    >
      {LIBRARY_TABS.map((tab) => (
        <TabsTrigger className="px-0 after:inset-x-0" key={tab.value} value={tab.value}>
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  )
}

type LibraryPageHeaderProps = {
  description?: string
  search: { label: string; placeholder: string; value: string; onSearch: (q: string) => void }
  action?: ReactNode
  tabs: ReactNode
}

export function LibraryPageHeader({ description, search, action, tabs }: LibraryPageHeaderProps) {
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-4">
        <div className="min-w-0">
          <h1 className="text-headline font-semibold text-on-surface">资料库</h1>
          {description === undefined ? null : (
            <p className="mt-2 text-body text-on-surface-variant">{description}</p>
          )}
        </div>
        <div className="flex w-full items-center gap-3 sm:w-auto">
          <div className={action === undefined ? 'w-full sm:w-100' : 'min-w-0 flex-1 sm:w-80'}>
            <SearchBox {...search} />
          </div>
          {action}
        </div>
      </header>
      {tabs}
    </>
  )
}

function SearchBox({
  label,
  placeholder,
  value,
  onSearch,
}: {
  label: string
  placeholder: string
  value: string
  onSearch: (q: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [applied, setApplied] = useState(value)
  if (value !== applied) {
    setApplied(value)
    setDraft(value)
  }

  // 父组件每次渲染都会给新的 onSearch，放进依赖会让计时反复重来。
  const search = useEffectEvent((q: string) => onSearch(q))
  useEffect(() => {
    if (draft.trim() === applied.trim()) return
    const timer = setTimeout(() => search(draft.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, applied])

  return (
    <Input
      aria-label={label}
      leadingIcon="search"
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      value={draft}
      wrapperClassName="h-(--control-height-xl) rounded-full"
    />
  )
}
