import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { conversationsQueryKeys, searchConversations } from '../conversations.api'
import { conversationRowsOf, useConversationRows } from '../conversation-rows'

type ConversationSearchDialogProps = {
  onOpenChange: (open: boolean) => void
  open: boolean
}

/** 搜索由后端执行，覆盖全部历史对话。 */
export function ConversationSearchDialog({ onOpenChange, open }: ConversationSearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        aria-label="搜索任务"
        // 打开弹窗时将焦点交给搜索框。
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title="搜索任务"
        />
        {/* 关闭时卸载，重置下次输入并停止订阅搜索。 */}
        {open ? <SearchPanel inputRef={inputRef} onNavigate={() => onOpenChange(false)} /> : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function SearchPanel({
  inputRef,
  onNavigate,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  onNavigate: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  useEffect(() => {
    // 输入停止 250ms 后发起搜索。
    const timer = setTimeout(() => setSubmitted(keyword.trim()), 250)
    return () => clearTimeout(timer)
  }, [keyword])

  const results = useQuery({
    enabled: submitted.length > 0,
    queryFn: async ({ client, signal }) =>
      conversationRowsOf(client).mergeRows(await searchConversations(submitted, signal)),
    queryKey: conversationsQueryKeys.search(submitted),
  })

  return (
    <>
      <div className="shrink-0 px-6 pb-3">
        <Input
          aria-label="搜索任务"
          leadingIcon="search"
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索任务标题"
          ref={inputRef}
          value={keyword}
        />
      </div>
      <DialogBody className="flex min-h-30 flex-col gap-0.5 pt-0">
        <SearchResults keyword={submitted} onNavigate={onNavigate} query={results} />
      </DialogBody>
    </>
  )
}

type SearchResultsProps = {
  keyword: string
  onNavigate: () => void
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof searchConversations>>>>
}

function SearchResults({ keyword, onNavigate, query }: SearchResultsProps) {
  if (!keyword) return <Hint>输入关键词可搜索任务</Hint>
  if (query.isPending) return <Hint>搜索中…</Hint>
  if (query.isError) {
    return <Hint>{errorMessageOf(query.error, '搜索任务失败')}</Hint>
  }
  return <SearchRows onNavigate={onNavigate} rows={query.data} />
}

/** 结果的成员来自这次搜索，行取池里的当前值：改名、删除在弹窗开着时也跟上。 */
function SearchRows({
  onNavigate,
  rows,
}: {
  onNavigate: () => void
  rows: Awaited<ReturnType<typeof searchConversations>>
}) {
  const shown = useConversationRows(rows)
  if (shown.length === 0) return <Hint>暂无匹配的任务</Hint>

  return (
    <ul aria-label="搜索结果" className="flex flex-col gap-0.5">
      {shown.map((conversation) => (
        <li key={conversation.id}>
          <Link
            className="block ui-state truncate rounded-sm px-2 py-2 text-body text-on-surface ui-focus"
            onClick={onNavigate}
            params={{ conversationId: conversation.id }}
            to="/c/$conversationId"
          >
            {conversation.title}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Hint({ children }: { children: string }) {
  return <p className="px-2 py-2 text-body-sm text-on-surface-variant">{children}</p>
}
