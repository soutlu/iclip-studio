import { useEffect, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { AUDIO_KIND_FILTERS, type AudioTraitFilter } from '@/shared/api/reference-audios'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { LoadMoreFooter } from '@/shared/ui/list-state'
import { libraryAudio, type LibraryAudio } from './audio'
import { EmptyNote } from './empty-note'
import { useLibraryAudios } from './final-cut.api'
import { TraitFilters } from './trait-filters'

const SEARCH_DEBOUNCE_MS = 300

/** 「音频库」里能看的子类：配乐或音效。 */
export type LibraryKind = 'bgm' | 'sfx'

/** 「音频库」当前看的子类和它的属性筛选（只放这个子类能筛的几项）。 */
export type LibraryScope = { kind: LibraryKind; traits: AudioTraitFilter }

const KIND_LABELS: Readonly<Record<LibraryKind, string>> = { bgm: '配乐', sfx: '音效' }

type AudioLibraryProps = {
  scope: LibraryScope
  onTraits: (traits: AudioTraitFilter) => void
  /** 搜索框里的字：停下来一会儿后按它搜音频库（匹配标题、备注）。 */
  query: string
  /** 搜索框本身：排在属性筛选上面。 */
  search: ReactNode
  /** 渲染单条音频行；试听、加入轨道、拖拽及「使用中」状态由调用方负责。 */
  renderRow: (audio: LibraryAudio) => ReactNode
}

/**
 * 「配乐」页签里的「音频库」：参考音频库里的配乐或音效（子类在页签顶行右边切换），按搜索框的字和属性筛选搜，
 * 建立晚的在前，一页一页往下读。画出来的几块直接排进页签（见 `.wf-audio`）。
 */
export function AudioLibrary({ scope, onTraits, query, search, renderRow }: AudioLibraryProps) {
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

  return (
    <>
      {search}
      <TraitFilters
        keys={AUDIO_KIND_FILTERS[scope.kind]}
        onChange={onTraits}
        total={total}
        value={scope.traits}
      />
      {readFailed ? (
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
      )}
    </>
  )
}
