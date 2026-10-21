import { useNavigate } from '@tanstack/react-router'
import { useRef, useState, type KeyboardEvent } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { aspectOf } from '@/shared/lib/aspect-ratio'
import { copyText } from '@/shared/lib/clipboard'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { Button, IconButton } from '@/shared/ui/button'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'
import { DialogTitle } from '@/shared/ui/dialog'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { Tag } from '@/shared/ui/tag'
import { toast } from '@/shared/ui/toast'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { VideoDownload } from '@/shared/ui/video-download'
import { VIDEO_PLAYER_SELECTOR } from '@/shared/ui/video-player'
import { useLibraryVideo, type LibraryVideo, type LibraryVideoDetail } from '../library.api'
import { cardTitleOf, durationSecondsOf, formatSecond, versionsOf } from '../library-media'
import { AuthorAvatar } from './author-avatar'
import { HitCasePanel, HitCasePanelSkeleton } from './hit-case-panel'
import { LibraryParamsPanel, LibraryScriptPanel } from './library-script'
import { LibraryVersionBar, LibraryVersionBarSkeleton } from './library-version-bar'
import { LibraryViewerFrame } from './library-viewer-frame'
import { ViewerPending, ViewerStage, ViewerVideo } from './library-viewer-stage'

// 恰好跳到镜头起点时画面可能停在上一镜的最后一帧，往后让一点。
const SEEK_NUDGE_S = 0.05

/** 右栏的页签；切到别的卡或别的版时留在原来的页签上。 */
type DetailPanel = 'script' | 'params' | 'hit-case'

type LibraryViewerProps = {
  videoId: string
  /** 打开时先选中的那一版；卡里没有这一版就选卡面。 */
  versionId: string | null
  listed: LibraryVideo | undefined
  startAt: number | null
  /** 上一条、下一条的 id，原样交给 `onNavigate`；是卡 id 还是版本 id 由调用方定。 */
  prevId: string | null
  nextId: string | null
  shareLink: string
  onNavigate: (id: string) => void
  onClose: () => void
  /** 点作者按人筛选；不给就只显示作者。 */
  onAuthor?: ((userName: string) => void) | undefined
  onRestoreFocus: () => boolean
}

export function LibraryViewer({
  videoId,
  versionId,
  listed,
  startAt,
  prevId,
  nextId,
  shareLink,
  onNavigate,
  onClose,
  onAuthor,
  onRestoreFocus,
}: LibraryViewerProps) {
  const detail = useLibraryVideo(videoId)
  const video = detail.data?.video ?? listed
  const [panel, setPanel] = useState<DetailPanel>('script')

  // React portal 里的嵌套浮层（菜单、参考图大图）的按键也冒泡到这里，它们自己用方向键。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const target = event.target
    if (
      !(target instanceof Element) ||
      target.closest('[role="dialog"]') !== event.currentTarget ||
      target.closest(`${VIDEO_PLAYER_SELECTOR}, [role="tablist"]`) !== null
    )
      return
    const id = event.key === 'ArrowLeft' ? prevId : nextId
    if (id === null) return
    event.preventDefault()
    onNavigate(id)
  }

  return (
    <LibraryViewerFrame
      onClose={onClose}
      onKeyDown={onKeyDown}
      onRestoreFocus={onRestoreFocus}
      outside={
        <>
          <NavButton direction="prev" id={prevId} onNavigate={onNavigate} />
          <NavButton direction="next" id={nextId} onNavigate={onNavigate} />
        </>
      }
    >
      {video === undefined ? (
        <ViewerPending
          title="资料库详情"
          error={detail.isError ? errorMessageOf(detail.error, '读取该视频失败') : null}
          onClose={onClose}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <ViewerBody
          detail={detail.data}
          detailError={
            detail.isError ? errorMessageOf(detail.error, '读取该视频的全部版本失败') : null
          }
          initialVersionId={versionId}
          key={`${videoId}:${versionId ?? ''}`}
          onAuthor={onAuthor}
          onClose={onClose}
          onPanelChange={setPanel}
          onRetry={() => void detail.refetch()}
          panel={panel}
          shareLink={shareLink}
          startAt={startAt}
          video={video}
        />
      )}
    </LibraryViewerFrame>
  )
}

function NavButton({
  direction,
  id,
  onNavigate,
}: {
  direction: 'prev' | 'next'
  id: string | null
  onNavigate: (id: string) => void
}) {
  return (
    <IconButton
      className={`library-viewer-glass absolute top-1/2 hidden size-12 -translate-y-1/2 rounded-full aria-disabled:cursor-default aria-disabled:opacity-30 lg:inline-grid ${direction === 'prev' ? 'left-5' : 'right-5'}`}
      disabled={id === null}
      label={direction === 'prev' ? '上一条' : '下一条'}
      name={direction === 'prev' ? 'back' : 'next'}
      onClick={() => {
        if (id !== null) onNavigate(id)
      }}
    />
  )
}

type ViewerBodyProps = {
  video: LibraryVideo
  detail: LibraryVideoDetail | undefined
  detailError: string | null
  initialVersionId: string | null
  startAt: number | null
  shareLink: string
  panel: DetailPanel
  onPanelChange: (panel: DetailPanel) => void
  onClose: () => void
  onAuthor: ((userName: string) => void) | undefined
  onRetry: () => void
}

const isDetailPanel = (value: string): value is DetailPanel =>
  value === 'script' || value === 'params' || value === 'hit-case'

function ViewerBody({
  video,
  detail,
  detailError,
  initialVersionId,
  startAt,
  shareLink,
  panel,
  onPanelChange,
  onClose,
  onAuthor,
  onRetry,
}: ViewerBodyProps) {
  const playerRef = useRef<HTMLVideoElement>(null)
  const pendingStartRef = useRef(startAt)
  const [selectedId, setSelectedId] = useState<string | null>(initialVersionId)
  const [currentTime, setCurrentTime] = useState(0)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const { copied, copy } = useCopyFeedback()

  const groups = detail?.groups ?? [
    { shotIndex: null, versions: [{ ...video.face, take: video.take }] },
  ]
  const wanted = selectedId ?? video.face.jobId
  const group =
    groups.find((item) => item.versions.some((entry) => entry.jobId === wanted)) ?? groups[0]
  if (group === undefined) return null
  const versions = versionsOf(group)
  const version = versions.find((item) => item.jobId === wanted) ?? versions.at(-1)
  if (version === undefined) return null

  const { w, h } = aspectOf(version.take.aspectRatio)
  const title = cardTitleOf(video)
  const author = version.userName
  const seconds = durationSecondsOf(version.durationMs, version.take)
  const tags = [
    version.take.model,
    version.take.aspectRatio,
    seconds === null ? null : `${formatSecond(seconds)} 秒`,
  ].filter((tag) => tag !== null)

  const seek = (at: number) => {
    const player = playerRef.current
    if (player === null) return
    player.currentTime = at + SEEK_NUDGE_S
    void player.play().catch(() => undefined)
  }
  const poster = videoSnapshotUrl(version.outputUrl, 720)

  return (
    <>
      <ViewerStage label="播放" onClose={onClose}>
        <ViewerVideo
          fallbackRatio={w / h}
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
          onLoadedMetadata={(event) => {
            const at = pendingStartRef.current
            pendingStartRef.current = null
            if (at !== null) event.currentTarget.currentTime = at + SEEK_NUDGE_S
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          playerRef={playerRef}
          poster={poster}
          src={version.outputUrl}
        />
        {detail !== undefined ? (
          <LibraryVersionBar
            group={group}
            groups={detail.groups}
            onSelect={setSelectedId}
            version={version}
            versions={versions}
          />
        ) : detailError === null ? (
          <LibraryVersionBarSkeleton
            groupCount={video.groupCount}
            versionCount={video.versionCount}
          />
        ) : null}
      </ViewerStage>

      <section
        aria-label="脚本与参数"
        className="flex min-h-0 w-full flex-col max-md:flex-none md:w-95 md:shrink-0 md:border-l md:border-hairline lg:w-105"
      >
        <header className="px-6 pt-4 max-md:px-4">
          {author === null ? null : onAuthor === undefined ? (
            <div className="-ml-1 inline-flex max-w-full items-center gap-2.5 py-1 pr-3 pl-1">
              <AuthorLine at={version.finishedAt} author={author} />
            </div>
          ) : (
            <button
              className="-ml-1 inline-flex max-w-full ui-state cursor-pointer items-center gap-2.5 rounded-full py-1 pr-3 pl-1 text-left ui-focus"
              onClick={() => onAuthor(author)}
              title={`仅显示 ${author} 的视频`}
              type="button"
            >
              <AuthorLine at={version.finishedAt} author={author} />
            </button>
          )}
          <DialogTitle className="mt-3 text-title-lg font-semibold">{title}</DialogTitle>
          {tags.length === 0 ? null : (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </div>
          )}
          {detailError === null ? null : (
            <p className="mt-3 flex items-center gap-2 text-body-sm text-error" role="alert">
              {detailError}
              <Button onClick={onRetry} size="md" variant="ghost">
                重试
              </Button>
            </p>
          )}
        </header>

        <TabsRoot
          className="flex min-h-0 flex-1 flex-col max-md:flex-none"
          onValueChange={(value) => {
            if (isDetailPanel(value)) onPanelChange(value)
          }}
          value={panel}
        >
          <TabsList
            aria-label="详情内容"
            className="mx-6 mt-3 h-10 shrink-0 gap-4 border-b border-hairline max-md:mx-4"
          >
            <TabsTrigger className="px-0 after:inset-x-0" value="script">
              脚本
            </TabsTrigger>
            <TabsTrigger className="px-0 after:inset-x-0" value="params">
              参数与来源
            </TabsTrigger>
            <TabsTrigger className="px-0 after:inset-x-0" value="hit-case">
              爆款素材
            </TabsTrigger>
          </TabsList>
          <TabsContent
            className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 max-md:overflow-visible max-md:px-4"
            value="script"
          >
            <LibraryScriptPanel
              currentTime={currentTime}
              onPreviewImage={setPreview}
              onSeek={seek}
              take={version.take}
            />
          </TabsContent>
          <TabsContent
            className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 max-md:overflow-visible max-md:px-4"
            value="params"
          >
            <LibraryParamsPanel
              showVersion={detail !== undefined}
              version={version}
              video={video}
            />
          </TabsContent>
          <TabsContent
            className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 max-md:overflow-visible max-md:px-4"
            value="hit-case"
          >
            {/* 版本还没读全时卡面那一版可能不是要找的那一版，读全了再问它的爆款状态。 */}
            {detail === undefined && detailError === null ? (
              <HitCasePanelSkeleton />
            ) : (
              <HitCasePanel jobId={version.jobId} key={version.jobId} />
            )}
          </TabsContent>
        </TabsRoot>

        <footer className="flex shrink-0 items-center gap-2 border-t border-hairline bg-surface-container-lowest px-6 pt-3.5 pb-4.5 max-md:sticky max-md:bottom-0 max-md:px-4 max-md:pb-[calc(12px+env(safe-area-inset-bottom))]">
          <MakeSameButton canMakeSame={detail?.canMakeSame ?? null} cardId={video.id} />
          <Button
            aria-label={copied ? '已复制' : '复制提示词'}
            className="shrink-0 rounded-full border-[0.5px] border-hairline px-3.5 text-body-sm max-sm:w-(--control-height-lg) max-sm:px-0"
            leadingIcon={copied ? 'check' : 'copy'}
            onClick={() => void copy(version.take.prompt)}
            variant="ghost"
          >
            <span className="max-sm:hidden">{copied ? '已复制' : '复制提示词'}</span>
          </Button>
          <VideoDownload
            className="size-(--control-height-lg) rounded-full"
            downloadedJobIds={[version.jobId]}
            durationMs={seconds === null ? null : seconds * 1000}
            enhanceSourceId={version.jobId}
            url={version.outputUrl}
            watermarkUrl={version.watermarkOutputUrl}
          />
          <MoreMenu
            conversationId={video.canOpenConversation ? video.conversationId : null}
            shareLink={shareLink}
          />
        </footer>
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

function AuthorLine({ author, at }: { author: string; at: string }) {
  return (
    <>
      <AuthorAvatar className="size-8 text-label" name={author} />
      <span className="min-w-0">
        <span className="block truncate text-body font-semibold">{author}</span>
        <span className="block text-caption text-on-surface-faint">{formatRelativeTime(at)}</span>
      </span>
    </>
  )
}

const MAKE_SAME_CLASS =
  'flex-1 rounded-full aria-disabled:bg-disabled-container aria-disabled:active:scale-100'

function MakeSameButton({ cardId, canMakeSame }: { cardId: string; canMakeSame: boolean | null }) {
  const navigate = useNavigate()
  const [hint, setHint] = useState(false)
  if (canMakeSame === true) {
    return (
      <Button
        className={MAKE_SAME_CLASS}
        leadingIcon="edit-image"
        onClick={() => void navigate({ search: { same: cardId }, to: '/' })}
        variant="inverted"
      >
        做同款
      </Button>
    )
  }
  const button = (
    <Button
      aria-disabled="true"
      className={MAKE_SAME_CLASS}
      leadingIcon="edit-image"
      variant="inverted"
    >
      做同款
    </Button>
  )
  if (canMakeSame === null) return button
  return (
    <TooltipRoot onOpenChange={setHint} open={hint}>
      <TooltipTrigger
        asChild
        // 触屏没有悬停，点按也要亮出提示；拦下默认处理，Radix 才不会在点击时把它关掉。
        onClick={(event) => {
          event.preventDefault()
          setHint(true)
        }}
      >
        {button}
      </TooltipTrigger>
      <TooltipContent side="top">该视频没有可用的制作文件，无法做同款</TooltipContent>
    </TooltipRoot>
  )
}

function MoreMenu({
  conversationId,
  shareLink,
}: {
  conversationId: string | null
  shareLink: string
}) {
  const navigate = useNavigate()
  const copyLink = async () => {
    try {
      await copyText(shareLink)
      toast.success('已复制链接')
    } catch {
      toast.error('复制失败，请重试')
    }
  }
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <IconButton
          className="size-(--control-height-lg) rounded-full border-[0.5px] border-hairline text-on-surface"
          label="更多操作"
          name="more"
        />
      </MenuTrigger>
      <MenuSurface align="end" side="top">
        <MenuItem icon="copy" onSelect={() => void copyLink()}>
          复制链接
        </MenuItem>
        {conversationId === null ? null : (
          <MenuItem
            icon="external"
            onSelect={() => void navigate({ params: { conversationId }, to: '/c/$conversationId' })}
          >
            打开来源任务
          </MenuItem>
        )}
      </MenuSurface>
    </MenuRoot>
  )
}
