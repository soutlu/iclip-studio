import { useState, type ReactNode } from 'react'
import { ListEmpty } from '@/shared/ui/list-state'
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
import { LibraryList } from './library-list'
import { useLoadNextPageWhen } from './library-next-page'
import { LibraryPageHeader } from './library-page-header'
import { useLibraryPageScroll } from './library-page-scroll'
import { LibraryPageShell } from './library-page-shell'
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
  const { mainRef, getScrollElement } = useLibraryPageScroll()
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

  const atLoadedEnd = index >= 0 && index === loaded.length - 1
  useLoadNextPageWhen(videos, atLoadedEnd)

  return (
    <LibraryPageShell
      attachments={
        videoId === null ? null : (
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
        )
      }
      filters={
        <LibraryFilters
          authors={authors}
          myUserName={myUserName}
          onChange={onScopeChange}
          scope={scope}
          trailing={counter}
        />
      }
      header={
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
      }
      label="资料库"
      mainRef={mainRef}
    >
      <LibraryList
        empty={
          <ListEmpty>
            {filtered ? '暂无匹配的视频，请更换关键词或清除筛选' : '暂无成功生成的视频'}
          </ListEmpty>
        }
        errorMessage="读取资料库失败"
        estimateHeight={cardHeightFor}
        getScrollElement={getScrollElement}
        items={loaded}
        keyOf={(video) => video.id}
        query={videos}
        renderItem={(video, width) => (
          <LibraryCard
            onAuthor={(userName) => onScopeChange({ ...scope, userName })}
            onOpen={openVideo}
            video={video}
            width={width}
          />
        )}
        shown={loaded.length}
        skeletonLabel="正在读取资料库"
        total={total}
      />
    </LibraryPageShell>
  )
}
