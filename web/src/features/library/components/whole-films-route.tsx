/** 整片资料库：按对话列卡，卡面是最新版本；详情只展示成片与版本。 */
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogTitle } from '@/shared/ui/dialog'
import { ListEmpty, ListError, ListPending, NextPageFooter } from '@/shared/ui/list-state'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { VideoDownload } from '@/shared/ui/video-download'
import { VideoPlayer } from '@/shared/ui/video-player'
import { useLibraryAuthorSource } from '../library.api'
import {
  REFERENCE_FALLBACK_RATIO,
  referenceCardHeightFor,
  snapshotWidthFor,
} from '../library-layout'
import { useLibraryWholeFilms, type WholeFilmCard, type WholeFilmScope } from '../whole-films.api'
import { AuthorAvatar } from './author-avatar'
import { LibraryFilters } from './library-filters'
import { LibraryGrid, LibraryGridSkeleton } from './library-grid'
import { LibraryPageHeader } from './library-page-header'
import { LibraryViewerFrame } from './library-viewer-frame'

type Props = {
  tabs: ReactNode
  scope: WholeFilmScope
  onScopeChange: (scope: WholeFilmScope) => void
  myUserName: string | null
  filmId: string | null
  onFilmChange: (id: string | null, replace: boolean) => void
}

const titleOf = (film: WholeFilmCard) => film.title?.trim() || '未命名整片'

export function WholeFilmsRoute({
  tabs,
  scope,
  onScopeChange,
  myUserName,
  filmId,
  onFilmChange,
}: Props) {
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const query = useLibraryWholeFilms(scope)
  const authors = useLibraryAuthorSource()
  const loaded = query.data?.pages.flatMap((page) => page.items) ?? []
  // 作者端点只收成片卡；补上已读整片卡的属主，不把仅有整片的作者遗漏掉。
  const authorOptions = new Map(authors.options.map((option) => [option.id, option]))
  for (const film of loaded) {
    if (film.userName !== null)
      authorOptions.set(film.userName, { id: film.userName, label: film.userName })
  }
  const total = query.data?.pages[0]?.total ?? undefined
  const selected = loaded.find((film) => film.conversationId === filmId)
  const filtered = scope.userName !== null || scope.q.trim() !== '' || scope.range !== 'all'
  const index = selected === undefined ? -1 : loaded.indexOf(selected)
  const { fetchNextPage, hasNextPage, isFetching, isError } = query
  // 整片没有单卡端点；地址直达时继续翻页找到该卡，详情翻到页尾也预读下一页。
  const needsPage = filmId !== null && (selected === undefined || index === loaded.length - 1)
  useEffect(() => {
    if (needsPage && hasNextPage && !isFetching && !isError)
      void fetchNextPage({ cancelRefetch: false })
  }, [needsPage, hasNextPage, isFetching, isError, fetchNextPage])

  const close = () => onFilmChange(null, true)
  const restoreFocus = () => {
    const button = mainRef.current?.querySelector<HTMLElement>(`[data-open-film="${filmId}"]`)
    button?.focus()
    return button != null
  }
  return (
    <main
      aria-label="整片资料库"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={mainRef}
    >
      <div className="flex w-full flex-col px-4 pt-12 pb-10 sm:px-(--layout-list-page-gutter) sm:pt-14">
        <LibraryPageHeader
          description="收录团队合成的整片，每段任务保留全部成片版本。"
          search={{
            label: '搜索整片标题',
            placeholder: '搜索任务标题…',
            value: scope.q,
            onSearch: (q) => onScopeChange({ ...scope, q }),
          }}
          tabs={tabs}
        />
        <div className="layer-content sticky top-0 -mx-1 bg-background px-1 py-3">
          <LibraryFilters
            authors={{ ...authors, options: [...authorOptions.values()] }}
            myUserName={myUserName}
            scope={{ ...scope, orientation: null }}
            showOrientation={false}
            allowUsernameInput
            onChange={(next) =>
              onScopeChange({
                q: next.q,
                userName: next.userName,
                range: next.range,
                since: next.since,
                until: next.until,
              })
            }
            trailing={total === undefined ? undefined : `${filtered ? '找到' : '共'} ${total} 条`}
          />
        </div>
        <div className="pt-3">
          {query.isPending ? (
            <LibraryGridSkeleton label="正在读取整片资料库" />
          ) : query.isError && !query.isFetchNextPageError ? (
            <ListError
              message={errorMessageOf(query.error, '读取整片资料库失败')}
              onRetry={() => void query.refetch()}
            />
          ) : loaded.length === 0 ? (
            <ListEmpty>
              {filtered
                ? '暂无匹配的整片，请更换关键词或清除筛选'
                : '暂无已合成的整片，请在任务中完成整片合成'}
            </ListEmpty>
          ) : (
            <LibraryGrid
              items={loaded}
              keyOf={(film) => film.conversationId}
              estimateHeight={(_, width) => referenceCardHeightFor(width)}
              getScrollElement={getScrollElement}
              renderItem={(film, width) => (
                <FilmCard
                  film={film}
                  width={width}
                  onOpen={() => onFilmChange(film.conversationId, false)}
                  onAuthor={(userName) => onScopeChange({ ...scope, userName })}
                />
              )}
            />
          )}
          {query.hasNextPage ? (
            query.isFetchNextPageError ? (
              <ListError
                message={errorMessageOf(query.error, '读取下一页失败')}
                onRetry={() => void query.fetchNextPage()}
              />
            ) : (
              <NextPageFooter
                query={query}
                getScrollElement={getScrollElement}
                shown={loaded.length}
                total={total}
              />
            )
          ) : null}
        </div>
      </div>
      {filmId === null ? null : (
        <LibraryViewerFrame onClose={close} onRestoreFocus={restoreFocus}>
          {selected === undefined ? (
            <div className="flex flex-1 flex-col items-center justify-center p-6">
              <DialogTitle className="sr-only">整片详情</DialogTitle>
              {query.isError ? (
                <ListError
                  message={errorMessageOf(query.error, '读取整片失败')}
                  onRetry={() => void query.refetch()}
                />
              ) : query.isPending || query.hasNextPage ? (
                <ListPending label="正在读取整片…" />
              ) : (
                <ListEmpty>当前筛选范围内没有这条整片，请关闭详情后清除筛选</ListEmpty>
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
      )}
    </main>
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
  const [ratio, setRatio] = useState(REFERENCE_FALLBACK_RATIO)
  const [failed, setFailed] = useState(false)
  const poster =
    width > 0
      ? videoSnapshotUrl(film.face.outputUrl, snapshotWidthFor(width, window.devicePixelRatio || 1))
      : undefined
  const title = titleOf(film)
  return (
    <article aria-label={title} className="library-card flex flex-col">
      <div
        className="relative overflow-hidden rounded-md bg-surface-container-low"
        style={{ aspectRatio: ratio }}
      >
        {poster === undefined || failed ? (
          <span className="absolute inset-0 grid place-items-center text-on-surface-variant">
            <Icon decorative name="video" size="xl" />
          </span>
        ) : (
          <img
            alt=""
            className="absolute inset-0 size-full object-contain"
            decoding="async"
            loading="lazy"
            src={poster}
            onError={() => setFailed(true)}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) setRatio(naturalWidth / naturalHeight)
            }}
          />
        )}
        <button
          aria-label={`查看整片：${title}`}
          data-open-film={film.conversationId}
          className="absolute inset-0 cursor-pointer rounded-md ui-focus"
          type="button"
          onClick={onOpen}
        />
        <span className="library-card-badge pointer-events-none absolute top-2 left-2">
          V{film.versions.length}
        </span>
        {film.face.durationMs === null ? null : (
          <span className="library-card-badge pointer-events-none absolute right-2 bottom-2">
            {(film.face.durationMs / 1000).toFixed(1)} 秒
          </span>
        )}
      </div>
      <div className="px-0.5 pt-2.5">
        <h3 className="line-clamp-2 text-body font-medium">{title}</h3>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-body-sm text-on-surface-variant">
          {film.userName === null ? null : (
            <button
              className="inline-flex min-w-0 ui-state items-center gap-1.5 rounded-full py-0.5 pr-1.5 ui-focus"
              type="button"
              onClick={() => {
                if (film.userName !== null) onAuthor(film.userName)
              }}
            >
              <AuthorAvatar className="size-4.5 text-caption" name={film.userName} />
              <span className="truncate">{film.userName}</span>
            </button>
          )}
          <span className="text-on-surface-faint">{formatRelativeTime(film.face.finishedAt)}</span>
        </div>
      </div>
    </article>
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
  const [measured, setMeasured] = useState<{ id: string; ratio: number } | null>(null)
  const ratio = measured?.id === version.jobId ? measured.ratio : REFERENCE_FALLBACK_RATIO
  const title = titleOf(film)
  const poster = videoSnapshotUrl(version.outputUrl, 720)
  return (
    <>
      <section
        aria-label="整片播放"
        className="relative flex min-w-0 flex-1 flex-col max-md:flex-none"
      >
        <IconButton
          className="layer-local-1 absolute top-4 right-4 size-10 rounded-full bg-surface-container-low"
          label="关闭"
          name="close"
          onClick={onClose}
        />
        <div className="relative min-h-0 flex-1 max-md:h-[56vh] max-md:flex-none">
          <div className="[container-type:size] absolute inset-3 grid place-items-center md:inset-6">
            <VideoPlayer
              autoPlay
              key={version.jobId}
              label={title}
              loop
              ref={playerRef}
              src={version.outputUrl}
              poster={poster}
              style={{ aspectRatio: ratio, width: `min(100cqw, ${100 * ratio}cqh)` }}
              onLoadedMetadata={(event) => {
                const { videoWidth, videoHeight } = event.currentTarget
                if (videoWidth > 0 && videoHeight > 0)
                  setMeasured({ id: version.jobId, ratio: videoWidth / videoHeight })
              }}
              onExpand={(at) =>
                setPreview({
                  kind: 'video',
                  name: title,
                  poster,
                  startAt: at,
                  url: version.outputUrl,
                })
              }
            />
          </div>
        </div>
        <div
          aria-label="整片版本"
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
      </section>
      <section
        aria-label="整片信息"
        className="flex w-full flex-col gap-4 p-6 md:w-80 md:shrink-0 md:border-l md:border-hairline"
      >
        <DialogTitle className="text-title-lg font-semibold">{title}</DialogTitle>
        <p className="text-body-sm text-on-surface-variant">
          {version.userName ?? '未知作者'} · {formatRelativeTime(version.finishedAt)}
        </p>
        {version.durationMs === null ? null : (
          <p className="text-body-sm text-on-surface-variant">
            时长 {(version.durationMs / 1000).toFixed(1)} 秒
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <VideoDownload
            jobId={version.jobId}
            url={version.outputUrl}
            watermarkUrl={version.watermarkOutputUrl}
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
