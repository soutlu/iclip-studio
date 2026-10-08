/** 资料库详情：左边播这张卡某个镜头组的某个版本、下面一行切组与版本，右边是脚本与参数；上一条 / 下一条在已读的列表里走。 */

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
import { VIDEO_PLAYER_SELECTOR, VideoPlayer } from '@/shared/ui/video-player'
import { useLibraryVideo, type LibraryVideo, type LibraryVideoDetail } from '../library.api'
import { cardTitleOf, durationSecondsOf, formatSecond, versionsOf } from '../library-media'
import { AuthorAvatar } from './author-avatar'
import { LibraryParamsPanel, LibraryScriptPanel } from './library-script'
import { LibraryVersionBar, LibraryVersionBarSkeleton } from './library-version-bar'
import { LibraryViewerFrame } from './library-viewer-frame'

/** 点镜头跳过去时往后让一点，免得停在上一镜的最后一帧。 */
const SEEK_NUDGE_S = 0.05

type LibraryViewerProps = {
  videoId: string
  /** 列表里已读到的这一条；详情读回来之前先拿它铺画面和脚本。 */
  listed: LibraryVideo | undefined
  /** 从故事板点某一帧进来时，从这一秒开始播。 */
  startAt: number | null
  prevId: string | null
  nextId: string | null
  /** 这一条的分享地址，「复制链接」给它。 */
  shareLink: string
  onNavigate: (id: string) => void
  onClose: () => void
  onAuthor: (userName: string) => void
  /** 关掉后由列表把焦点放回卡片；卡片已被虚拟列表回收时返回 false，交给弹窗的默认去处。 */
  onRestoreFocus: () => boolean
}

export function LibraryViewer({
  videoId,
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

  // 左右方向键翻上一条 / 下一条。嵌套的浮层（菜单、参考图大图）经 portal 冒泡上来，
  // 与播放器、页签一样自己用方向键，不抢。
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
          key={videoId}
          onAuthor={onAuthor}
          onClose={onClose}
          onRetry={() => void detail.refetch()}
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

/** 分享来的链接指向的片子不在已读列表里：详情回来之前只有状态。 */
function ViewerPending({
  error,
  onClose,
  onRetry,
}: {
  error: string | null
  onClose: () => void
  onRetry: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <DialogTitle className="sr-only">资料库详情</DialogTitle>
      {error === null ? (
        <p className="text-body-sm text-on-surface-variant" role="status">
          正在读取…
        </p>
      ) : (
        <>
          <p className="text-body text-on-surface" role="alert">
            {error}
          </p>
          <div className="flex gap-2">
            <Button onClick={onRetry} size="md" variant="inverted">
              重试
            </Button>
            <Button onClick={onClose} size="md" variant="ghost">
              关闭
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

type ViewerBodyProps = {
  video: LibraryVideo
  detail: LibraryVideoDetail | undefined
  detailError: string | null
  startAt: number | null
  shareLink: string
  onClose: () => void
  onAuthor: (userName: string) => void
  onRetry: () => void
}

function ViewerBody({
  video,
  detail,
  detailError,
  startAt,
  shareLink,
  onClose,
  onAuthor,
  onRetry,
}: ViewerBodyProps) {
  const playerRef = useRef<HTMLVideoElement>(null)
  // 起播位置只对打开时那个版本生效一次，换版本从头播。
  const pendingStartRef = useRef(startAt)
  // 只记选中的那一版，所在的镜头组由它推出来；没选过就是卡面那一版。
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 片子读到元数据后量出的真实比例；请求里的画幅可能认不出（如 adaptive）或与成片不符。
  const [measured, setMeasured] = useState<{ jobId: string; ratio: number } | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const { copied, copy } = useCopyFeedback()

  // 详情回来之前只有卡面那一版，切组与版本的那一行等它回来再出。
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
  const ratio = measured?.jobId === version.jobId ? measured.ratio : w / h
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
      <section aria-label="播放" className="relative flex min-w-0 flex-1 flex-col max-md:flex-none">
        <IconButton
          className="layer-local-1 absolute top-4 right-4 size-10 rounded-full bg-surface-container-low text-on-surface"
          label="关闭"
          name="close"
          onClick={onClose}
        />
        <div className="relative min-h-0 flex-1 max-md:h-[56vh] max-md:flex-none">
          {/* 视频盒与画面同比例、在这块区域里等比放到最大：圆角落在画面上，两侧不留底色块。 */}
          <div className="[container-type:size] absolute inset-3 grid place-items-center md:inset-6">
            <VideoPlayer
              autoPlay
              className="bg-surface-container-low"
              key={version.jobId}
              label={title}
              loop
              // 放大接着当前进度在灯箱里播，关掉后把灯箱播到的位置写回来。
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
                const { videoWidth, videoHeight } = event.currentTarget
                if (videoWidth > 0 && videoHeight > 0)
                  setMeasured({ jobId: version.jobId, ratio: videoWidth / videoHeight })
                const at = pendingStartRef.current
                pendingStartRef.current = null
                if (at !== null) event.currentTarget.currentTime = at + SEEK_NUDGE_S
              }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              poster={poster}
              ref={playerRef}
              src={version.outputUrl}
              style={{ aspectRatio: ratio, width: `min(100cqw, ${100 * ratio}cqh)` }}
            />
          </div>
        </div>
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
      </section>

      <section
        aria-label="脚本与参数"
        className="flex min-h-0 w-full flex-col max-md:flex-none md:w-95 md:shrink-0 md:border-l md:border-hairline lg:w-105"
      >
        <header className="px-6 pt-4 max-md:px-4">
          {author === null ? null : (
            <button
              className="-ml-1 inline-flex max-w-full ui-state cursor-pointer items-center gap-2.5 rounded-full py-1 pr-3 pl-1 text-left ui-focus"
              onClick={() => onAuthor(author)}
              title={`只看 ${author} 的片子`}
              type="button"
            >
              <AuthorAvatar className="size-8 text-label" name={author} />
              <span className="min-w-0">
                <span className="block truncate text-body font-semibold">{author}</span>
                <span className="block text-caption text-on-surface-faint">
                  {formatRelativeTime(version.finishedAt)}
                </span>
              </span>
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

        <TabsRoot className="flex min-h-0 flex-1 flex-col max-md:flex-none" defaultValue="script">
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
          {/* 版本是一条出片或合成，id 与地址取自同一条记录。 */}
          <VideoDownload
            className="size-(--control-height-lg) rounded-full"
            jobId={version.jobId}
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

const MAKE_SAME_CLASS =
  'flex-1 rounded-full aria-disabled:bg-disabled-container aria-disabled:active:scale-100'

/** 「做同款」：能做时去首页、把卡 id 带在查询串里，由首页进入做同款；能不能做只有详情知道，详情回来之前置灰、不说原因。
 *
 * 做不了时外观是禁用的主按钮，但留在 tab 序列里，悬停、聚焦、点按都亮出原因，点了不做别的。 */
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

/** 复制链接人人都有；打开来源对话只给打得开那段对话的读者：对话 id 人人都拿得到，由调用方按 canOpenConversation 决定传不传。 */
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
