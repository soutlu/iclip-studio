/** 资料库页：页头与搜索、吸顶筛选条、瀑布流与翻页，加上盖在列表上的详情。筛选范围与打开着的详情由路由存在查询参数里。 */

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { Input } from '@/shared/ui/field'
import { ListEmpty, ListError } from '@/shared/ui/list-state'
import {
  isDefaultScope,
  useLibraryAuthorSource,
  useLibraryVideos,
  type LibraryScope,
} from '../library.api'
import { LibraryFilters } from './library-filters'
import { LibraryGrid, LibraryGridSkeleton } from './library-grid'
import { LibraryViewer } from './library-viewer'

/** 停止输入这么久才按关键词重查。 */
const SEARCH_DEBOUNCE_MS = 300

type LibraryRouteProps = {
  scope: LibraryScope
  onScopeChange: (next: LibraryScope) => void
  myUserName: string | null
  /** 打开着详情的那张卡。 */
  videoId: string | null
  /** 打开、换一条或关掉（null）详情；`replace` 是在详情里翻条，不新增历史记录。 */
  onVideoChange: (id: string | null, replace: boolean) => void
  /** 一张卡的分享地址。 */
  shareLinkOf: (id: string) => string
}

export function LibraryRoute({
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

  // 从故事板点帧进来的起播秒数，只对那一条有效。
  const [startAt, setStartAt] = useState<{ id: string; at: number } | null>(null)
  const openVideo = (id: string, at: number | null) => {
    setStartAt(at === null ? null : { at, id })
    onVideoChange(id, false)
  }
  const index = videoId === null ? -1 : loaded.findIndex((video) => video.id === videoId)
  const prevId = index > 0 ? (loaded[index - 1]?.id ?? null) : null
  const nextId = index >= 0 ? (loaded[index + 1]?.id ?? null) : null

  // 自动翻页的两个入口（详情翻到末尾、页脚进入一屏内）可能前后脚触发；不取消在途请求，第二次直接复用它。
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = videos
  const loadNextPage = useCallback(
    () => void fetchNextPage({ cancelRefetch: false }),
    [fetchNextPage],
  )

  // 翻到已读的最后一条时接着读下一页，「下一条」不会停在页尾；翻页失败就停下，由页脚重试。
  const atLoadedEnd = index >= 0 && index === loaded.length - 1
  useEffect(() => {
    if (atLoadedEnd && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) loadNextPage()
  }, [atLoadedEnd, hasNextPage, isFetchNextPageError, isFetchingNextPage, loadNextPage])

  // 关掉详情后焦点回到那张卡；卡已被虚拟列表回收就交给弹窗的默认去处。
  const focusCard = (id: string): boolean => {
    const button = mainRef.current?.querySelector<HTMLElement>(`[data-open-video="${id}"]`)
    button?.focus()
    return button != null
  }

  return (
    <main
      aria-label="资料库"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={mainRef}
    >
      {/* 页头预留侧栏展开按钮的覆盖空间。 */}
      <div className="mx-auto flex w-full max-w-400 flex-col px-4 pt-12 pb-10 sm:px-8 sm:pt-14">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-5">
          <div>
            <h1 className="text-headline font-semibold text-on-surface">资料库</h1>
            <p className="mt-2 text-body text-on-surface-variant">
              团队出过的每一条片，连同生成它的脚本。挑一条，直接拿来再创作。
            </p>
          </div>
          <SearchBox onSearch={(q) => onScopeChange({ ...scope, q })} value={scope.q} />
        </header>

        {/* 页内吸顶只需压住卡片；应用壳的侧栏抽屉在更高一层。 */}
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
              {filtered ? '没有找到匹配的片子，换个关键词或清除筛选再看看' : '还没有成功出过的片'}
            </ListEmpty>
          ) : (
            <LibraryGrid
              getScrollElement={getScrollElement}
              onAuthor={(userName) => onScopeChange({ ...scope, userName })}
              onOpen={openVideo}
              videos={loaded}
            />
          )}

          {/* 翻页失败只落在页脚，已读取的卡片照常显示。 */}
          {videos.hasNextPage ? (
            videos.isFetchNextPageError && !videos.isFetchingNextPage ? (
              <ListError
                message={errorMessageOf(videos.error, '读取资料库失败')}
                onRetry={() => void videos.fetchNextPage()}
              />
            ) : (
              <NextPageFooter
                getScrollElement={getScrollElement}
                isFetching={videos.isFetchingNextPage}
                loadedAt={videos.dataUpdatedAt}
                onApproach={loadNextPage}
                paused={videos.isFetching || videos.isError}
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
          onRestoreFocus={() => focusCard(videoId)}
          prevId={prevId}
          shareLink={shareLinkOf(videoId)}
          startAt={startAt?.id === videoId ? startAt.at : null}
          videoId={videoId}
        />
      )}
    </main>
  )
}

type NextPageFooterProps = {
  /** 页面的滚动容器；页脚进入它可视区下方一屏以内就算接近底部。 */
  getScrollElement: () => HTMLElement | null
  isFetching: boolean
  /** 最近一次读到数据的时刻；每变一次都按当下位置重新判断。 */
  loadedAt: number
  /** 暂停期间不观察，恢复时按当下位置重新判断。 */
  paused: boolean
  onApproach: () => void
  shown: number
  total: number | undefined
}

/** 翻页页脚：左边写已显示几条，右边是读下一页的状态；滚到接近底部时请调用方读下一页。 */
function NextPageFooter({
  getScrollElement,
  isFetching,
  loadedAt,
  paused,
  onApproach,
  shown,
  total,
}: NextPageFooterProps) {
  const footerRef = useRef<HTMLElement>(null)
  const approach = useEffectEvent(onApproach)

  // 相交状态不变就不回调，所以每读到一次数据、每次暂停结束都重建观察器，让它按当下布局再报一次；
  // 只跟暂停不够，一页回来得快时「读取中」那次渲染会被合并掉。
  useEffect(() => {
    const footer = footerRef.current
    if (paused || footer === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) approach()
      },
      // 根得是滚动容器本身，下边距才会按它的一屏往外扩；用视口当根，页脚会先被容器裁掉。
      { root: getScrollElement(), rootMargin: '0px 0px 100% 0px' },
    )
    observer.observe(footer)
    return () => observer.disconnect()
  }, [getScrollElement, loadedAt, paused])

  return (
    <footer
      className="flex items-center justify-between gap-4 px-3 py-4 text-body text-on-surface-variant"
      ref={footerRef}
    >
      <span>{total === undefined ? `已显示 ${shown}` : `已显示 ${shown} / ${total}`}</span>
      {/* 读屏只播报已在页面上的 live region 的变化，所以它常驻、只换内容。 */}
      <p className="flex h-(--control-height-md) items-center gap-2" role="status">
        {isFetching ? (
          <>
            <Icon className="animate-spin" decorative name="loading" size="sm" />
            正在读取…
          </>
        ) : null}
      </p>
    </footer>
  )
}

/** 搜索框：输入即时显示，停顿后才改筛选；外部把关键词清掉时跟着清。 */
function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
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
    <div className="w-full sm:w-100">
      <Input
        aria-label="搜索脚本"
        leadingIcon="search"
        onChange={(event) => setDraft(event.target.value)}
        placeholder="搜场景、动作、镜头语言…"
        value={draft}
        wrapperClassName="h-(--control-height-xl) rounded-full"
      />
    </div>
  )
}
