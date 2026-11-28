import { useEffect, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { LoadMoreFooter } from '@/shared/ui/list-state'
import { libraryAudio, type LibraryAudio, type LibraryKind, type LibraryScope } from './audio'
import { EmptyNote } from './empty-note'
import { useLibraryAudios } from './final-cut.api'

const SEARCH_DEBOUNCE_MS = 300

const KIND_LABELS: Readonly<Record<LibraryKind, string>> = { bgm: '配乐', sfx: '音效' }

type AudioLibraryProps = {
  scope: LibraryScope
  /** 搜索框里的字：停下来一会儿后按它搜音频库（匹配标题、备注）。 */
  query: string
  /** 渲染单条音频行；试听、加入轨道、拖拽及「已用」状态由调用方负责。 */
  renderRow: (audio: LibraryAudio) => ReactNode
}

/**
 * 「配乐」页签里「音频库」的列表：参考音频库里的配乐或音效，按搜索框的字和属性筛选搜，
 * 建立晚的在前，一页一页往下读。搜索框和筛选在页签头里（见 `AudioTab`）。
 */
export function AudioLibrary({ scope, query, renderRow }: AudioLibraryProps) {
  const [keyword, setKeyword] = useState(query.trim())
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  const library = useLibraryAudios(scope.kind, keyword, scope.traits)
  const items = library.data?.pages.flatMap((page) => page.items.map(libraryAudio)) ?? []
  const total = library.data?.pages[0]?.total ?? undefined
  const readFailed = library.isError && !library.isFetchNextPageError
  const filtered = keyword !== '' || Object.values(scope.traits).some((each) => each !== undefined)

  return readFailed ? (
    <div className="wf-audio-alert">
      <InlineAlert
        action={{ label: '重试', onClick: () => void library.refetch() }}
        message={errorMessageOf(library.error, '读取音频库失败')}
      />
    </div>
  ) : library.isPending ? (
    <EmptyNote icon="final-cut-music">正在读取音频库…</EmptyNote>
  ) : items.length === 0 ? (
    <EmptyNote icon="final-cut-music">
      {filtered
        ? '暂无符合条件的音频，请更换关键词或筛选条件'
        : `音频库中暂无${KIND_LABELS[scope.kind]}，可在资料库的「音频库」中添加`}
    </EmptyNote>
  ) : (
    <ul aria-label="音频库" className="wf-tab-list wf-audio-list">
      {items.map(renderRow)}
      {library.hasNextPage ? (
        <li className="wf-audio-more">
          {library.isFetchNextPageError && !library.isFetchingNextPage ? (
            <InlineAlert
              action={{ label: '重试', onClick: () => void library.fetchNextPage() }}
              message={errorMessageOf(library.error, '读取音频库失败')}
            />
          ) : (
            <LoadMoreFooter
              isFetching={library.isFetchingNextPage}
              label="加载更多"
              onMore={() => void library.fetchNextPage()}
              shown={items.length}
              total={total}
            />
          )}
        </li>
      ) : null}
    </ul>
  )
}
