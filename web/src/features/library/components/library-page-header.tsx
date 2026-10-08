/** 资料库两个页签共用的页头：标题与一句说明、搜索框、可选的主动作，下面一行是「成片｜参考视频」页签。 */

import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { Input } from '@/shared/ui/field'
import { TabsList, TabsTrigger } from '@/shared/ui/tabs'

/** 停止输入这么久才按关键词重查。 */
const SEARCH_DEBOUNCE_MS = 300

/** 资料库的两个页签；成片是默认页签。取值与路由查询串里的 `tab` 对应。 */
const LIBRARY_TABS = [
  { label: '成片', value: 'videos' },
  { label: '参考视频', value: 'references' },
] as const

/** 页签行：放在路由的 TabsRoot 里，选中哪个由路由记在地址上。 */
export function LibraryTabsList() {
  return (
    <TabsList aria-label="资料库内容" className="h-10 gap-6 border-b border-hairline">
      {LIBRARY_TABS.map((tab) => (
        <TabsTrigger className="px-0 after:inset-x-0" key={tab.value} value={tab.value}>
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  )
}

type LibraryPageHeaderProps = {
  description: string
  search: { label: string; placeholder: string; value: string; onSearch: (q: string) => void }
  /** 搜索框右边的主动作，如「上传视频」。 */
  action?: ReactNode
  /** 页签行；由路由给。 */
  tabs: ReactNode
}

export function LibraryPageHeader({ description, search, action, tabs }: LibraryPageHeaderProps) {
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-4">
        <div className="min-w-0">
          <h1 className="text-headline font-semibold text-on-surface">资料库</h1>
          <p className="mt-2 text-body text-on-surface-variant">{description}</p>
        </div>
        <div className="flex w-full items-center gap-3 sm:w-auto">
          {/* 旁边有主动作时让出宽度。 */}
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

/** 搜索框：输入即时显示，停顿后才改筛选；外部把关键词清掉时跟着清。 */
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
