import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { useMediaDownload } from '@/shared/api/media-download'
import { Icon } from '@/shared/icons'
import { copyText } from '@/shared/lib/clipboard'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogTitle } from '@/shared/ui/dialog'
import { Textarea } from '@/shared/ui/field'
import { Markdown } from '@/shared/ui/markdown'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { VideoPlayer } from '@/shared/ui/video-player'
import { PLACEHOLDER_VIDEO_RATIO } from '../library-layout'
import { failureMessageOf, tagsOf, UNTAGGED_YET, type VideoTypeLabels } from '../reference-labels'
import {
  CATEGORY_VALUES,
  isBreakdownBusy,
  nearestTestAspectRatio,
  useReference,
  useRemoveReference,
  useRerunReference,
  useStartTestVideo,
  useUpdateReference,
  VIDEO_TYPE_VALUES,
  type ReferenceDetail,
  type ReferenceItem,
} from '../references.api'
import { AuthorAvatar } from './author-avatar'
import { ReferenceTagRow } from './reference-tags'
import { LibraryViewerFrame } from './library-viewer-frame'
import { ViewerPending, ViewerStage } from './library-viewer-stage'
import { CompareOverlay, TestVideoCell } from './test-video-slot'

const INVERTED_CLASS = 'rounded-full disabled:bg-disabled-container'

const CONFLICT_MESSAGE = '该拆解已被修改，刷新将丢弃本次修改'

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409

type Mode = 'view' | 'edit' | 'confirm-rerun' | 'confirm-remove'

type ReferenceViewerProps = {
  referenceId: string
  listed: ReferenceItem | undefined
  labels: VideoTypeLabels
  myUserName: string | null
  onClose: () => void
  onAuthor: (userName: string) => void
  onRestoreFocus: () => boolean
}

export function ReferenceViewer({
  referenceId,
  listed,
  labels,
  myUserName,
  onClose,
  onAuthor,
  onRestoreFocus,
}: ReferenceViewerProps) {
  const detail = useReference(referenceId)
  const [mode, setMode] = useState<Mode>('view')
  const reference: ReferenceItem | undefined = detail.data ?? listed

  return (
    <LibraryViewerFrame
      onClose={onClose}
      onEscapeKeyDown={(event) => {
        if (mode === 'view') return
        event.preventDefault()
        setMode('view')
      }}
      onRestoreFocus={onRestoreFocus}
    >
      {reference === undefined ? (
        <ViewerPending
          title="参考视频详情"
          error={detail.isError ? errorMessageOf(detail.error, '读取该参考视频失败') : null}
          onClose={onClose}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <ViewerBody
          detail={detail.data}
          labels={labels}
          mode={mode}
          myUserName={myUserName}
          onAuthor={onAuthor}
          onClose={onClose}
          onModeChange={setMode}
          onRefresh={() => void detail.refetch()}
          reference={reference}
        />
      )}
    </LibraryViewerFrame>
  )
}

type ViewerBodyProps = {
  reference: ReferenceItem
  detail: ReferenceDetail | undefined
  labels: VideoTypeLabels
  mode: Mode
  myUserName: string | null
  onModeChange: (mode: Mode) => void
  onRefresh: () => void
  onClose: () => void
  onAuthor: (userName: string) => void
}

type Preview = { media: LightboxMedia; player: 'original' | 'test' }

function ViewerBody({
  reference,
  detail,
  labels,
  mode,
  myUserName,
  onModeChange,
  onRefresh,
  onClose,
  onAuthor,
}: ViewerBodyProps) {
  const playerRef = useRef<HTMLVideoElement>(null)
  const testPlayerRef = useRef<HTMLVideoElement>(null)
  const [measuredRatio, setMeasuredRatio] = useState<number | null>(null)
  const ratio = measuredRatio ?? PLACEHOLDER_VIDEO_RATIO
  const [preview, setPreview] = useState<Preview | null>(null)
  const [draft, setDraft] = useState('')
  const [conflict, setConflict] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const footerRef = useRef<HTMLElement>(null)
  const previousModeRef = useRef(mode)
  useEffect(() => {
    if (previousModeRef.current === mode) return
    previousModeRef.current = mode
    if (mode === 'edit') editorRef.current?.focus()
    else
      footerRef.current
        ?.querySelector<HTMLButtonElement>(mode === 'view' ? 'button' : 'button:last-of-type')
        ?.focus()
  }, [mode])
  useEffect(() => {
    if (conflict)
      footerRef.current?.querySelector<HTMLButtonElement>('button:last-of-type')?.focus()
    else if (previousModeRef.current === 'edit') editorRef.current?.focus()
  }, [conflict])
  const update = useUpdateReference(reference.id)
  const rerun = useRerunReference(reference.id)
  const remove = useRemoveReference(reference.id)
  const startTest = useStartTestVideo(reference.id)
  const { downloading, download } = useMediaDownload()

  const busy = isBreakdownBusy(reference.breakdownStatus)
  const document = detail?.document ?? null
  const tags = tagsOf(reference, labels)
  const title = tags.length === 0 ? '参考视频' : tags.join(' · ')
  const author = reference.userName
  const tagsEditable = reference.canEdit && detail !== undefined && document !== null && !busy
  const saving = update.isPending

  const saveTags = (patch: Pick<ReferenceDetail, 'videoTypes' | 'categories'>) => {
    if (detail === undefined || document === null) return
    update.mutate(
      {
        categories: patch.categories,
        document,
        version: detail.version,
        videoTypes: patch.videoTypes,
      },
      {
        onError: (error) => {
          if (isConflict(error)) {
            toast.error('该拆解已被修改，标签无法保存；已刷新为最新内容')
            onRefresh()
          } else toast.error(errorMessageOf(error, '标签保存失败'))
        },
      },
    )
  }

  const startEdit = () => {
    if (document === null) return
    setDraft(document)
    setConflict(false)
    onModeChange('edit')
  }

  const saveDocument = () => {
    if (detail === undefined) return
    update.mutate(
      {
        categories: detail.categories,
        document: draft,
        version: detail.version,
        videoTypes: detail.videoTypes,
      },
      {
        onError: (error) => {
          if (isConflict(error)) setConflict(true)
          else toast.error(errorMessageOf(error, '保存失败'))
        },
        onSuccess: () => {
          toast.success('已保存')
          onModeChange('view')
        },
      },
    )
  }

  const confirmRerun = () =>
    rerun.mutate(undefined, {
      onError: (error) => {
        if (isConflict(error)) {
          toast.error('该视频正在拆解，无法重新拆解；请在拆解完成后重试')
          onRefresh()
        } else toast.error(errorMessageOf(error, '重新拆解提交失败'))
        onModeChange('view')
      },
      onSuccess: () => onModeChange('view'),
    })

  const confirmRemove = () =>
    remove.mutate(undefined, {
      onError: (error) => toast.error(errorMessageOf(error, '移除失败')),
      onSuccess: () => {
        toast.success('已从资料库移除')
        onClose()
      },
    })

  const copyDocument = async () => {
    if (document === null) return
    try {
      await copyText(document)
      toast.success('已复制拆解')
    } catch {
      toast.error('复制失败，请重试')
    }
  }

  const testReady = detail !== undefined && document !== null && !busy
  const submitTest = () => {
    if (measuredRatio === null || !testReady) return
    startTest.mutate(nearestTestAspectRatio(measuredRatio), {
      onError: (error) => {
        toast.error(errorMessageOf(error, '试生成失败'))
        // 服务端以 409 表示拆解状态或上一次试生成与画面上的不一致。
        if (isConflict(error)) onRefresh()
      },
    })
  }

  const poster = videoSnapshotUrl(reference.videoUrl, 720)
  const downloadVideo = () => void download(reference.videoUrl, '参考视频')

  return (
    <>
      <ViewerStage label="播放" onClose={onClose}>
        <div className="relative min-h-0 flex-1 max-md:flex-none">
          <div className="[container-type:size] absolute inset-3 grid place-items-center max-md:[container-type:inline-size] max-md:static max-md:px-3 max-md:pt-16 max-md:pb-2 md:inset-6">
            <div
              className="reference-compare"
              data-orient={ratio > 1 ? 'landscape' : 'portrait'}
              style={{ '--reference-ratio': ratio } as CSSProperties}
            >
              <div className="reference-compare-cell">
                <VideoPlayer
                  autoPlay
                  className="absolute inset-0 bg-surface-container-low"
                  label="原片"
                  loop
                  onExpand={(at) =>
                    setPreview({
                      media: {
                        kind: 'video',
                        name: title,
                        poster,
                        startAt: at,
                        url: reference.videoUrl,
                      },
                      player: 'original',
                    })
                  }
                  onLoadedMetadata={(event) => {
                    const { videoWidth, videoHeight } = event.currentTarget
                    if (videoWidth > 0 && videoHeight > 0)
                      setMeasuredRatio(videoWidth / videoHeight)
                  }}
                  poster={poster}
                  ref={playerRef}
                  src={reference.videoUrl}
                />
                <CompareOverlay label="原片" />
              </div>
              <TestVideoCell
                measured={measuredRatio !== null}
                onExpand={(url, at) =>
                  setPreview({
                    media: { kind: 'video', name: '试生成', startAt: at, url },
                    player: 'test',
                  })
                }
                onStart={submitTest}
                owner={myUserName !== null && reference.userName === myUserName}
                playerRef={testPlayerRef}
                poster={poster}
                ready={testReady}
                starting={startTest.isPending}
                testVideo={detail?.testVideo}
              />
            </div>
          </div>
        </div>
      </ViewerStage>

      <section
        aria-label="拆解"
        className="flex min-h-0 w-full flex-col max-md:flex-none md:w-95 md:shrink-0 md:border-l md:border-hairline lg:w-130"
      >
        <header className="border-b border-hairline px-6 pt-4 pb-4 max-md:px-4">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          {author === null ? null : (
            <button
              className="-ml-1 inline-flex max-w-full ui-state cursor-pointer items-center gap-2.5 rounded-full py-1 pr-3 pl-1 text-left ui-focus"
              onClick={() => onAuthor(author)}
              title={`仅显示 ${author} 的参考视频`}
              type="button"
            >
              <AuthorAvatar className="size-8 text-label" name={author} />
              <span className="min-w-0">
                <span className="block truncate text-body font-semibold">{author}</span>
                <span className="block text-caption text-on-surface-faint">
                  {formatRelativeTime(reference.createdAt)}
                </span>
              </span>
            </button>
          )}
          <div className="mt-4 grid gap-2.5">
            <ReferenceTagRow
              busy={saving}
              editable={tagsEditable && mode === 'view'}
              emptyText={busy ? UNTAGGED_YET : '未标注'}
              label="片子类型"
              onChange={(ids) =>
                saveTags({
                  categories: reference.categories,
                  videoTypes: VIDEO_TYPE_VALUES.filter((type) => ids.includes(type)),
                })
              }
              options={VIDEO_TYPE_VALUES.flatMap((type) => {
                const label = labels.get(type)
                return label === undefined ? [] : [{ id: type, label }]
              })}
              values={reference.videoTypes.flatMap((type) => {
                const label = labels.get(type)
                return label === undefined ? [] : [{ id: type, label }]
              })}
            />
            <ReferenceTagRow
              busy={saving}
              editable={tagsEditable && mode === 'view'}
              emptyText={busy ? UNTAGGED_YET : '未标注'}
              label="品类"
              onChange={(ids) =>
                saveTags({
                  categories: ids.flatMap((id) => CATEGORY_VALUES.filter((name) => name === id)),
                  videoTypes: reference.videoTypes,
                })
              }
              options={CATEGORY_VALUES.map((name) => ({ id: name, label: name }))}
              values={reference.categories.map((name) => ({ id: name, label: name }))}
            />
          </div>
        </header>

        {mode === 'edit' ? (
          <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-4 max-md:min-h-[60vh] max-md:px-4">
            <div className="mb-2.5 flex items-baseline justify-between gap-3">
              <label
                className="text-body-sm font-semibold text-on-surface"
                htmlFor="reference-document"
              >
                拆解
              </label>
              <span className="text-caption text-on-surface-faint">修改完成后点击「保存」</span>
            </div>
            <Textarea
              className="min-h-0 flex-1 resize-none font-mono text-body-sm leading-relaxed whitespace-pre-wrap"
              disabled={saving}
              id="reference-document"
              onChange={(event) => setDraft(event.target.value)}
              ref={editorRef}
              value={draft}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 max-md:overflow-visible max-md:px-4">
            <BreakdownBody detail={detail} document={document} reference={reference} />
          </div>
        )}

        <footer
          className="flex shrink-0 items-center gap-2 border-t border-hairline bg-surface-container-lowest px-6 pt-3.5 pb-4.5 max-md:sticky max-md:bottom-0 max-md:px-4 max-md:pb-[calc(12px+env(safe-area-inset-bottom))]"
          ref={footerRef}
        >
          {mode === 'edit' && conflict ? (
            <>
              <span
                className="min-w-0 flex-1 text-body-sm text-balance text-on-surface"
                role="alert"
              >
                {CONFLICT_MESSAGE}
              </span>
              <Button
                className="shrink-0 rounded-full"
                onClick={() => setConflict(false)}
                variant="outlined"
              >
                取消
              </Button>
              <Button
                className={cn('shrink-0', INVERTED_CLASS)}
                onClick={() => {
                  setConflict(false)
                  onRefresh()
                  onModeChange('view')
                }}
                variant="inverted"
              >
                刷新
              </Button>
            </>
          ) : mode === 'edit' ? (
            <>
              <span className="min-w-0 flex-1 text-body-sm text-balance text-on-surface-faint">
                仅修改文字，不会重新拆解
              </span>
              <Button
                className="shrink-0 rounded-full"
                onClick={() => onModeChange('view')}
                variant="outlined"
              >
                取消
              </Button>
              <Button
                className={cn('shrink-0', INVERTED_CLASS)}
                disabled={draft.trim() === '' || draft === document}
                loading={saving}
                onClick={saveDocument}
                variant="inverted"
              >
                保存
              </Button>
            </>
          ) : mode === 'confirm-rerun' || mode === 'confirm-remove' ? (
            <>
              <span
                className="min-w-0 flex-1 text-body-sm text-balance text-on-surface"
                role="status"
              >
                {mode === 'confirm-rerun'
                  ? '重新拆解会覆盖当前的拆解和标签，包括手动修改过的内容'
                  : '移除后该视频不再出现在资料库中，AI 导演仍可使用它的拆解'}
              </span>
              <Button
                className="shrink-0 rounded-full"
                onClick={() => onModeChange('view')}
                variant="outlined"
              >
                取消
              </Button>
              <Button
                className={cn('shrink-0', INVERTED_CLASS)}
                loading={mode === 'confirm-rerun' ? rerun.isPending : remove.isPending}
                onClick={mode === 'confirm-rerun' ? confirmRerun : confirmRemove}
                variant="inverted"
              >
                {mode === 'confirm-rerun' ? '重新拆解' : '移除'}
              </Button>
            </>
          ) : reference.canEdit ? (
            <>
              <Button
                className={cn('flex-1', INVERTED_CLASS)}
                disabled={busy || document === null}
                leadingIcon="edit"
                onClick={startEdit}
                variant="inverted"
              >
                编辑拆解
              </Button>
              <Button
                className="flex-1 rounded-full"
                disabled={busy || detail === undefined}
                leadingIcon="refresh"
                onClick={() => onModeChange('confirm-rerun')}
                variant="outlined"
              >
                重新拆解
              </Button>
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton
                    className="size-(--control-height-lg) shrink-0 rounded-full border border-outline-variant text-on-surface"
                    label="更多操作"
                    name="more"
                  />
                </MenuTrigger>
                <MenuSurface align="end" side="top">
                  {document === null ? null : (
                    <MenuItem icon="copy" onSelect={() => void copyDocument()}>
                      复制拆解
                    </MenuItem>
                  )}
                  <MenuItem disabled={downloading} icon="download" onSelect={downloadVideo}>
                    下载视频
                  </MenuItem>
                  <MenuItem icon="delete" onSelect={() => onModeChange('confirm-remove')}>
                    从资料库移除
                  </MenuItem>
                </MenuSurface>
              </MenuRoot>
            </>
          ) : (
            <>
              <Button
                className="flex-1 rounded-full"
                disabled={document === null}
                leadingIcon="copy"
                onClick={() => void copyDocument()}
                variant="outlined"
              >
                复制拆解
              </Button>
              <IconButton
                className="size-(--control-height-lg) shrink-0 rounded-full border border-outline-variant text-on-surface"
                disabled={downloading}
                label={downloading ? '正在准备下载…' : '下载视频'}
                name={downloading ? 'loading' : 'download'}
                onClick={downloadVideo}
              />
            </>
          )}
        </footer>
      </section>

      <MediaLightbox
        media={preview?.media ?? null}
        onClose={(at) => {
          const player = (preview?.player === 'test' ? testPlayerRef : playerRef).current
          setPreview(null)
          if (at !== undefined && player !== null) player.currentTime = at
        }}
      />
    </>
  )
}

function BreakdownBody({
  reference,
  detail,
  document,
}: {
  reference: ReferenceItem
  detail: ReferenceDetail | undefined
  document: string | null
}) {
  const busy = isBreakdownBusy(reference.breakdownStatus)
  const notice = busy ? (
    <p
      className="mb-4 flex items-start gap-3 rounded-md bg-surface-container-low px-3.5 py-3 text-body-sm text-on-surface-variant"
      role="status"
    >
      <Icon
        className="mt-0.5 shrink-0 animate-spin text-on-surface"
        decorative
        name="spinner"
        size="sm"
      />
      <span>
        {reference.breakdownStatus === 'pending'
          ? '排队中，即将开始拆解。'
          : '正在拆解，通常需要几分钟。'}
        {document === null
          ? '关闭详情不影响拆解，完成后会自动显示在此处。'
          : '完成后将替换下方的拆解和标签。'}
      </span>
    </p>
  ) : reference.breakdownStatus === 'failed' ? (
    <p
      className="mb-4 flex items-start gap-3 rounded-md bg-surface-container-low px-3.5 py-3 text-body-sm text-on-surface"
      role="alert"
    >
      <Icon className="mt-0.5 shrink-0 text-error" decorative name="alert" size="sm" />
      <span>{failureMessageOf(reference.errorCode, document !== null)}</span>
    </p>
  ) : null

  return (
    <>
      {notice}
      <h3 className="mb-2.5 flex items-baseline justify-between gap-3 text-body-sm font-semibold text-on-surface">
        拆解
        {document === null || detail === undefined ? null : (
          <span className="text-caption font-normal text-on-surface-faint">
            {formatRelativeTime(detail.updatedAt)}更新
          </span>
        )}
      </h3>
      {document !== null ? (
        <Markdown className="reference-breakdown text-body-sm break-words" text={document} />
      ) : detail === undefined || busy ? (
        <DocumentSkeleton />
      ) : (
        <p className="text-body-sm text-on-surface-faint">暂无拆解</p>
      )}
    </>
  )
}

const SKELETON_LINES = [
  { id: 'h1', width: '40%' },
  { id: 'p1', width: '92%' },
  { id: 'p2', width: '86%' },
  { id: 'p3', width: '70%' },
  { id: 'gap', width: null },
  { id: 'h2', width: '35%' },
  { id: 'p4', width: '95%' },
  { id: 'p5', width: '88%' },
  { id: 'p6', width: '60%' },
] as const

function DocumentSkeleton() {
  return (
    <div aria-hidden className="grid gap-3 pt-1 motion-safe:animate-pulse">
      {SKELETON_LINES.map(({ id, width }) => (
        <span
          className={width === null ? 'h-1.5' : 'h-2.5 rounded-full bg-surface-container'}
          key={id}
          style={width === null ? undefined : { width }}
        />
      ))}
    </div>
  )
}
