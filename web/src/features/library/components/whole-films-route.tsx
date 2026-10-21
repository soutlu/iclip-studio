import { useNavigate } from '@tanstack/react-router'
import { useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { Button } from '@/shared/ui/button'
import { DialogTitle } from '@/shared/ui/dialog'
import { ListEmpty, ListError, ListPending } from '@/shared/ui/list-state'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { VideoDownload } from '@/shared/ui/video-download'
import { isDefaultScope } from '../library.api'
import { PLACEHOLDER_VIDEO_RATIO, placeholderCardHeightFor } from '../library-layout'
import {
  useLibraryWholeFilms,
  useWholeFilmAuthorSource,
  type WholeFilmCard,
  type WholeFilmScope,
} from '../whole-films.api'
import { CardByline } from './card-byline'
import { focusCardOpener } from './card-focus'
import { LibraryFilters } from './library-filters'
import { LibraryList } from './library-list'
import { useLoadNextPageWhen } from './library-next-page'
import { LibraryPageHeader } from './library-page-header'
import { useLibraryPageScroll } from './library-page-scroll'
import { LibraryPageShell } from './library-page-shell'
import { LibraryViewerFrame } from './library-viewer-frame'
import { ViewerStage, ViewerVideo } from './library-viewer-stage'
import { PlaceholderRatioCard } from './placeholder-ratio-card'

type Props = {
  tabs: ReactNode
  scope: WholeFilmScope
  onScopeChange: (scope: WholeFilmScope) => void
  myUserName: string | null
  filmId: string | null
  onFilmChange: (id: string | null, replace: boolean) => void
}

const titleOf = (film: WholeFilmCard) => film.title?.trim() || '未命名成片'

/** 资料库「成片」：全站导出的成片，一段对话一张卡，卡面是最新一次导出，详情里切换各版。 */
export function WholeFilmsRoute({
  tabs,
  scope,
  onScopeChange,
  myUserName,
  filmId,
  onFilmChange,
}: Props) {
  const { mainRef, getScrollElement } = useLibraryPageScroll()
  const query = useLibraryWholeFilms(scope)
  const authors = useWholeFilmAuthorSource()
  const loaded = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total ?? undefined
  const selected = loaded.find((film) => film.conversationId === filmId)
  const filtered = !isDefaultScope(scope)
  const index = selected === undefined ? -1 : loaded.indexOf(selected)
  const needsPage = filmId !== null && (selected === undefined || index === loaded.length - 1)
  useLoadNextPageWhen(query, needsPage)

  const close = () => onFilmChange(null, true)
  return (
    <LibraryPageShell
      label="资料库"
      mainRef={mainRef}
      header={
        <LibraryPageHeader
          description="收录团队导出的成片，每段任务保留每一次导出。"
          search={{
            label: '搜索成片标题',
            placeholder: '搜索任务标题…',
            value: scope.q,
            onSearch: (q) => onScopeChange({ ...scope, q }),
          }}
          tabs={tabs}
        />
      }
      filters={
        <LibraryFilters
          authors={authors}
          myUserName={myUserName}
          scope={scope}
          onChange={onScopeChange}
          trailing={total === undefined ? undefined : `${filtered ? '找到' : '共'} ${total} 条`}
        />
      }
      attachments={
        filmId === null ? null : (
          <LibraryViewerFrame
            onClose={close}
            onRestoreFocus={() => focusCardOpener(mainRef.current, filmId)}
          >
            {selected === undefined ? (
              <div className="flex flex-1 flex-col items-center justify-center p-6">
                <DialogTitle className="sr-only">成片详情</DialogTitle>
                {query.isError ? (
                  <ListError
                    message={errorMessageOf(query.error, '读取成片失败')}
                    onRetry={() => void query.refetch()}
                  />
                ) : query.isPending || query.hasNextPage ? (
                  <ListPending label="正在读取成片…" />
                ) : (
                  <ListEmpty>该成片不在当前筛选范围内，无法显示；请关闭详情后清除筛选</ListEmpty>
                )}
                <Button onClick={close} variant="ghost">
                  关闭
                </Button>
              </div>
            ) : (
              <FilmViewer
                key={selected.conversationId}
                film={selected}
                onClose={close}
                previous={loaded[index - 1]?.conversationId}
                next={loaded[index + 1]?.conversationId}
                onNavigate={(id) => onFilmChange(id, true)}
              />
            )}
          </LibraryViewerFrame>
        )
      }
    >
      <LibraryList
        query={query}
        getScrollElement={getScrollElement}
        skeletonLabel="正在读取成片"
        errorMessage="读取成片失败"
        empty={
          <ListEmpty>
            {filtered
              ? '暂无匹配的成片，请更换关键词或清除筛选'
              : '暂无导出的成片，请在任务的成片编辑器中导出'}
          </ListEmpty>
        }
        items={loaded}
        keyOf={(film) => film.conversationId}
        estimateHeight={(_, width) => placeholderCardHeightFor(width)}
        renderItem={(film, width) => (
          <FilmCard
            film={film}
            width={width}
            onOpen={() => onFilmChange(film.conversationId, false)}
            onAuthor={(userName) => onScopeChange({ ...scope, userName })}
          />
        )}
        shown={loaded.length}
        total={total}
      />
    </LibraryPageShell>
  )
}

function FilmCard({
  film,
  width,
  onOpen,
  onAuthor,
}: {
  film: WholeFilmCard
  width: number
  onOpen: () => void
  onAuthor: (name: string) => void
}) {
  const title = titleOf(film)
  return (
    <PlaceholderRatioCard
      badges={
        <span className="library-card-badge pointer-events-none absolute top-2 left-2">
          V{film.versions.length}
        </span>
      }
      cardId={film.conversationId}
      label={title}
      onOpen={onOpen}
      openLabel={`查看成片：${title}`}
      videoUrl={film.face.outputUrl}
      width={width}
    >
      <h3 className="line-clamp-2 text-body font-medium">{title}</h3>
      <CardByline
        at={film.face.finishedAt}
        author={film.userName}
        itemNoun="成片"
        onAuthor={onAuthor}
      />
    </PlaceholderRatioCard>
  )
}

function FilmViewer({
  film,
  onClose,
  previous,
  next,
  onNavigate,
}: {
  film: WholeFilmCard
  onClose: () => void
  previous: string | undefined
  next: string | undefined
  onNavigate: (id: string) => void
}) {
  const navigate = useNavigate()
  const [selected, setSelected] = useState(film.face.jobId)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const playerRef = useRef<HTMLVideoElement>(null)
  const version = film.versions.find((item) => item.jobId === selected) ?? film.face
  const title = titleOf(film)
  const poster = videoSnapshotUrl(version.outputUrl, 720)
  return (
    <>
      <ViewerStage label="成片播放" onClose={onClose}>
        <ViewerVideo
          fallbackRatio={PLACEHOLDER_VIDEO_RATIO}
          key={version.jobId}
          label={title}
          onExpand={(at) =>
            setPreview({
              kind: 'video',
              name: title,
              poster,
              startAt: at,
              url: version.outputUrl,
            })
          }
          playerRef={playerRef}
          poster={poster}
          src={version.outputUrl}
        />
        <div
          aria-label="成片版本"
          role="group"
          className="flex flex-wrap justify-center gap-2 px-4 py-4"
        >
          {film.versions.map((item, index) => (
            <button
              className="library-viewer-segment ui-focus"
              aria-pressed={item.jobId === version.jobId}
              key={item.jobId}
              type="button"
              onClick={() => setSelected(item.jobId)}
            >
              V{index + 1}
            </button>
          ))}
        </div>
      </ViewerStage>
      <section
        aria-label="成片信息"
        className="flex w-full flex-col gap-4 p-6 md:w-80 md:shrink-0 md:border-l md:border-hairline"
      >
        <DialogTitle className="text-title-lg font-semibold">{title}</DialogTitle>
        <p className="text-body-sm text-on-surface-variant">
          {version.userName ?? '未知作者'} · {formatRelativeTime(version.finishedAt)}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <VideoDownload
            downloadedJobIds={version.sourceJobIds}
            enhanceSourceId={version.jobId}
            originalLabel="下载成片"
            url={version.outputUrl}
            watermarkUrl={null}
          />
          {film.canOpenConversation ? (
            <Button
              size="md"
              variant="ghost"
              leadingIcon="external"
              onClick={() =>
                void navigate({
                  to: '/c/$conversationId',
                  params: { conversationId: film.conversationId },
                })
              }
            >
              打开来源任务
            </Button>
          ) : null}
        </div>
        <div className="flex justify-between gap-2">
          <Button
            size="md"
            variant="ghost"
            disabled={previous === undefined}
            onClick={() => {
              if (previous !== undefined) onNavigate(previous)
            }}
          >
            上一条
          </Button>
          <Button
            size="md"
            variant="ghost"
            disabled={next === undefined}
            onClick={() => {
              if (next !== undefined) onNavigate(next)
            }}
          >
            下一条
          </Button>
        </div>
      </section>
      <MediaLightbox
        media={preview}
        onClose={(at) => {
          setPreview(null)
          if (at !== undefined && playerRef.current !== null) playerRef.current.currentTime = at
        }}
      />
    </>
  )
}
