import { useEffect, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useAudition } from '@/shared/ui/audition'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { LoadMoreFooter } from '@/shared/ui/list-state'
import { libraryAudio, type LibraryAudio } from './audio'
import { useLibraryAudios } from './final-cut.api'

const SEARCH_DEBOUNCE_MS = 300

type LibraryKind = 'bgm' | 'sfx'

const KINDS: readonly { value: LibraryKind; label: string }[] = [
  { value: 'bgm', label: '配乐' },
  { value: 'sfx', label: '音效' },
]

type AudioLibraryProps = {
  /** 这一块是不是正显示着；被藏起来时停止试听。 */
  active: boolean
  /** 搜索框里的字：停下来一会儿后按它搜音频库（匹配标题、备注）。 */
  query: string
  onNotice: (message: string) => void
  /** 画出一行：这条音频和它的试听状态。加进 final-cut、拖动和「使用中」都由画行的那边管。 */
  renderRow: (
    audio: LibraryAudio,
    audition: { playing: boolean; onToggle: () => void },
  ) => ReactNode
}

/**
 * 「配乐」页签里的「音频库」：参考音频库里的配乐或音效（上面切换），按搜索框的字搜，建立晚的在前，一页一页往下读。
 * 每行能试听（同一时间只放一条，这一块藏起来或卸掉时停下）。
 */
export function AudioLibrary({ active, query, onNotice, renderRow }: AudioLibraryProps) {
  const [kind, setKind] = useState<LibraryKind>('bgm')
  const [keyword, setKeyword] = useState(query.trim())
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  const library = useLibraryAudios(kind, keyword)
  const items = library.data?.pages.flatMap((page) => page.items.map(libraryAudio)) ?? []
  const total = library.data?.pages[0]?.total ?? undefined
  const { playing, toggle } = useAudition({
    active,
    onError: () => onNotice('音频试听失败，请重试'),
  })
  const kindLabel = KINDS.find((each) => each.value === kind)?.label ?? ''
  const readFailed = library.isError && !library.isFetchNextPageError

  return (
    <>
      <ChipGroup
        aria-label="音频库分类"
        className="wf-audio-kinds"
        onValueChange={(value) => {
          const next = KINDS.find((each) => each.value === value)
          if (next !== undefined) setKind(next.value)
        }}
        type="single"
        value={kind}
      >
        {KINDS.map((each) => (
          <FilterChip key={each.value} value={each.value}>
            {each.label}
          </FilterChip>
        ))}
      </ChipGroup>
      {readFailed ? (
        <div className="wf-audio-note">
          <InlineAlert
            action={{ label: '重试', onClick: () => void library.refetch() }}
            message={errorMessageOf(library.error, '读取音频库失败')}
          />
        </div>
      ) : library.isPending ? (
        <p className="wf-audio-note" role="status">
          正在读取音频库…
        </p>
      ) : items.length === 0 ? (
        <p className="wf-audio-note" role="status">
          {keyword === ''
            ? `音频库里暂无${kindLabel}，可在资料库的「音频库」中添加`
            : '暂无符合条件的音频，请更换关键词'}
        </p>
      ) : (
        <ul aria-label="音频库" className="wf-audio-list">
          {items.map((item) =>
            renderRow(item, {
              playing: playing === item.id,
              onToggle: () => toggle(item.id, item.url),
            }),
          )}
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
