import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { ListEmpty, ListError, NextPageFooter } from '@/shared/ui/list-state'
import {
  isDefaultScope,
  useLibraryAuthorSource,
  useLibraryVideos,
  type LibraryScope,
} from '../library.api'
import { cardHeightFor } from '../library-layout'
import { focusCardOpener } from './card-focus'
import { LibraryCard } from './library-card'
import { LibraryFilters } from './library-filters'
import { LibraryGrid, LibraryGridSkeleton } from './library-grid'
import { LibraryPageHeader } from './library-page-header'
import { LibraryViewer } from './library-viewer'

type LibraryRouteProps = {
  tabs: ReactNode
  scope: LibraryScope
  onScopeChange: (next: LibraryScope) => void
  myUserName: string | null
  videoId: string | null
  onVideoChange: (id: string | null, replace: boolean) => void
  shareLinkOf: (id: string) => string
}

export function LibraryRoute({
  tabs,
  scope,
  onScopeChange,
  myUserName,
  videoId,
  onVideoChange,
  shareLinkOf,
}: LibraryRouteProps) {
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const videos = useLibraryVideos(scope)
  const authors = useLibraryAuthorSource()
  const loaded = videos.data?.pages.flatMap((page) => page.items) ?? []
  const total = videos.data?.pages[0]?.total ?? undefined

  const filtered = !isDefaultScope(scope)
  const counter = total === undefined ? undefined : filtered ? `找到 ${total} 条` : `共 ${total} 条`

  const [startAt, setStartAt] = useState<{ id: string; at: number } | null>(null)
  const openVideo = (id: string, at: number | null) => {
    setStartAt(at === null ? null : { at, id })
    onVideoChange(id, false)
  }
  const index = videoId === null ? -1 : loaded.findIndex((video) => video.id === videoId)
  const prevId = index > 0 ? (loaded[index - 1]?.id ?? null) : null
  const nextId = index >= 0 ? (loaded[index + 1]?.id ?? null) : null

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = videos
  const loadNextPage = useCallback(
    () => void fetchNextPage({ cancelRefetch: false }),
    [fetchNextPage],
  )

  const atLoadedEnd = index >= 0 && index === loaded.length - 1
  useEffect(() => {
    if (atLoadedEnd && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) loadNextPage()
  }, [atLoadedEnd, hasNextPage, isFetchNextPageError, isFetchingNextPage, loadNextPage])

  return (
    <main
      aria-label="资料库"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={mainRef}
    >
      <div className="flex w-full flex-col px-4 pt-12 pb-10 sm:px-(--layout-list-page-gutter) sm:pt-14">
        <LibraryPageHeader
          description="收录团队生成的每一条视频及其生成脚本。选择任一视频，可直接基于它再创作。"
          search={{
            label: '搜索脚本',
            onSearch: (q) => onScopeChange({ ...scope, q }),
            placeholder: '搜索场景、动作、镜头语言…',
            value: scope.q,
          }}
          tabs={tabs}
        />

        <div className="layer-content sticky top-0 -mx-1 bg-background px-1 py-3">
          <LibraryFilters
            authors={authors}
            myUserName={myUserName}
            onChange={onScopeChange}
            scope={scope}
            trailing={counter}
          />
        </div>

        <div className="pt-3">
          {videos.isPending ? (
            <LibraryGridSkeleton label="正在读取资料库" />
          ) : videos.isError && !videos.isFetchNextPageError ? (
            <ListError
              message={errorMessageOf(videos.error, '读取资料库失败')}
              onRetry={() => void videos.refetch()}
            />
          ) : loaded.length === 0 ? (
            <ListEmpty>
              {filtered ? '暂无匹配的视频，请更换关键词或清除筛选' : '暂无成功生成的视频'}
            </ListEmpty>
          ) : (
            <LibraryGrid
              estimateHeight={cardHeightFor}
              getScrollElement={getScrollElement}
              items={loaded}
              keyOf={(video) => video.id}
              renderItem={(video, width) => (
                <LibraryCard
                  onAuthor={(userName) => onScopeChange({ ...scope, userName })}
                  onOpen={openVideo}
                  video={video}
                  width={width}
                />
              )}
            />
          )}

          {videos.hasNextPage ? (
            videos.isFetchNextPageError && !videos.isFetchingNextPage ? (
              <ListError
                message={errorMessageOf(videos.error, '读取资料库失败')}
                onRetry={() => void videos.fetchNextPage()}
              />
            ) : (
              <NextPageFooter
                getScrollElement={getScrollElement}
                query={videos}
                shown={loaded.length}
                total={total}
              />
            )
          ) : null}
        </div>
      </div>

      {videoId === null ? null : (
        <LibraryViewer
          listed={index >= 0 ? loaded[index] : undefined}
          nextId={nextId}
          onAuthor={(userName) => onScopeChange({ ...scope, userName })}
          onClose={() => onVideoChange(null, true)}
          onNavigate={(id) => {
            setStartAt(null)
            onVideoChange(id, true)
          }}
          onRestoreFocus={() => focusCardOpener(mainRef.current, videoId)}
          prevId={prevId}
          shareLink={shareLinkOf(videoId)}
          startAt={startAt?.id === videoId ? startAt.at : null}
          videoId={videoId}
        />
      )}
    </main>
  )
}
