import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import type { WholeFilmDraftOut } from '@/shared/api/generated/types.gen'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { DialogHeader, DialogRoot, DialogSurface, useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MediaBuffering } from '@/shared/ui/media-buffering'
import { toast } from '@/shared/ui/toast'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { keyframeRanges } from '../editing/keyframe-segments'
import { isShortcutTarget } from '../editing/shortcut-target'
import { handleUndoShortcut } from '../editing/undo-shortcut'
import { useStableValue } from '../editing/use-stable-value'
import { useShotGenerations } from '../storyboard.api'
import { useComponentCatalog, type ComponentCatalog } from './component-catalog'
import type { Canvas } from './composition/film'
import { EditorToolbar } from './editor-toolbar'
import { ExportControl } from './export-control'
import { FilmTimeline, type DropGhost, type RowTarget, type TimelineHandle } from './film-timeline'
import { MaterialArea } from './material-area'
import {
  useKeyframeIndexes,
  useVideoSize,
  videoSizeQuery,
  type KeyframeStates,
} from './material-media'
import { MaterialPreview, type MaterialPreviewControl, type MaterialView } from './material-preview'
import {
  materialCatalog,
  rangePieces,
  shotAt,
  usedSpans,
  type Material,
  type MaterialRange,
  type MaterialTake,
} from './materials'
import { landingOn, rowOpening } from './placement'
import { previewDocument } from './preview-document'
import { PreviewPlayer, type PlaybackSettings, type PreviewControl } from './preview-player'
import { PreviewTransport } from './preview-transport'
import { aroundPlayhead } from './selection'
import {
  FIT_ZOOM,
  snapSpanStartMs,
  snapTargets,
  timelineScale,
  zoomScrollLeft,
  zoomToBlocks,
  type Zoom,
} from './timeline-scale'
import { useFilmSession } from './use-film-session'
import { useWholeFilmExport } from './use-whole-film-export'
import { useWholeFilmDraftQuery } from './whole-film.api'
import './whole-film.css'

type Props = {
  conversationId: string
  conversationTitle: string
  onClose: () => void
}

const EMPTY_TEXT = '成片里还没有画面；加入素材片后可以在这里预览'
const PICK_FIRST_TEXT = '先在下方点一个镜头选中范围'
const NO_FULLSCREEN_TEXT = '当前浏览器不支持全屏'

const watchFullscreen = (notify: () => void) => {
  document.addEventListener('fullscreenchange', notify)
  return () => document.removeEventListener('fullscreenchange', notify)
}

const fullscreenElementOf = () => document.fullscreenElement ?? null

function EditorHeader({ actions, title }: { actions: ReactNode; title: string }) {
  return (
    <DialogHeader
      actions={actions}
      className="editor-header"
      closeLabel="关闭成片编辑"
      title={title}
    />
  )
}

export function WholeFilmEditor({ conversationId, conversationTitle, onClose }: Props) {
  const draftQuery = useWholeFilmDraftQuery(conversationId)
  const catalogQuery = useComponentCatalog()
  const keysRef = useRef<((event: KeyboardEvent<HTMLDivElement>) => void) | null>(null)
  const failed = draftQuery.isError ? draftQuery : catalogQuery.isError ? catalogQuery : undefined
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogSurface
        aria-describedby={undefined}
        className="editor-dialog wf-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (event.target instanceof HTMLElement) event.target.focus()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => keysRef.current?.(event)}
      >
        {draftQuery.data !== undefined && catalogQuery.data !== undefined ? (
          <EditorBody
            catalog={catalogQuery.data}
            conversationId={conversationId}
            initial={draftQuery.data}
            keysRef={keysRef}
            title={conversationTitle}
          />
        ) : (
          <>
            <EditorHeader actions={null} title={conversationTitle} />
            {failed !== undefined ? (
              <div className="wf-state">
                <InlineAlert
                  action={{ label: '重试', onClick: () => void failed.refetch() }}
                  message={errorMessageOf(
                    failed.error,
                    failed === draftQuery ? '成片草稿读取失败' : '组件库读取失败',
                  )}
                />
              </div>
            ) : (
              <p className="wf-state" role="status">
                正在读取成片草稿…
              </p>
            )}
          </>
        )}
      </DialogSurface>
    </DialogRoot>
  )
}

const takeLetterOf = (material: Material) => material.takeLabel.replace(/^生成\s*/, '')

const shotNumberOf = (ms: number, url: string, keyframes: KeyframeStates) => {
  const state = keyframes.get(url)
  return state?.kind === 'ready' ? shotAt(keyframeRanges(state.index), ms / 1000) : undefined
}

const shotsLabelOf = (range: MaterialRange, url: string, keyframes: KeyframeStates) => {
  const [first] = range.shots
  const last = range.shots.at(-1)
  if (first === undefined || last === undefined) return ''
  const from = shotNumberOf((first.startMs + first.endMs) / 2, url, keyframes)
  const to = shotNumberOf((last.startMs + last.endMs) / 2, url, keyframes)
  if (from === undefined || to === undefined) return ''
  return from === to ? ` · 镜头 ${from}` : ` · 镜头 ${from}–${to}`
}

function EditorBody({
  conversationId,
  initial,
  catalog,
  keysRef,
  title,
}: {
  conversationId: string
  initial: WholeFilmDraftOut
  catalog: ComponentCatalog
  title: string
  keysRef: RefObject<((event: KeyboardEvent<HTMLDivElement>) => void) | null>
}) {
  const notice = useCallback((message: string) => toast.info(message), [])
  const session = useFilmSession(conversationId, initial, catalog, { onNotice: notice })
  const { film } = session
  const pictures = useMemo(() => film?.pictures ?? [], [film])
  const [materialView, setMaterialView] = useState<MaterialView | null>(null)
  const [materialMs, setMaterialMs] = useState(0)
  const [materialPlaying, setMaterialPlaying] = useState(false)
  const materialPreviewRef = useRef<MaterialPreviewControl | null>(null)
  const leaveMaterial = () => {
    setMaterialView(null)
    setMaterialPlaying(false)
  }

  const videos = useShotGenerations(conversationId)
  const materials = useMemo(
    () => materialCatalog(groupConversationVideos(videos.data ?? [])),
    [videos.data],
  )
  const [pickedVersions, setPickedVersions] = useState<Readonly<Record<string, string>>>({})
  const versionOf = (take: MaterialTake): Material =>
    take.versions.find((item) => item.jobId === pickedVersions[take.id]) ?? take.latest
  const shownUrls = useStableValue(
    [
      ...new Set(
        materials.groups.flatMap((group) => group.takes.map((take) => versionOf(take).url)),
      ),
    ].sort(),
  )
  const keyframes = useKeyframeIndexes(shownUrls)

  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [buffered, setBuffered] = useState<readonly TimeSpan[]>([])
  const previewRef = useRef<PreviewControl | null>(null)
  const [range, setRange] = useState<MaterialRange | null>(null)
  const [playback, setPlayback] = useState<PlaybackSettings>({ rate: 1, muted: false, loop: false })
  const toggleMute = () => setPlayback((current) => ({ ...current, muted: !current.muted }))
  const toggleLoop = () => setPlayback((current) => ({ ...current, loop: !current.loop }))

  // 预览和播放条一起全屏；全屏时提示、菜单、面板要挂进这个元素才看得见
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const fullscreenElement = useSyncExternalStore(watchFullscreen, fullscreenElementOf)
  const fullscreen = stage !== null && fullscreenElement === stage
  const fullscreenBlocked = document.fullscreenEnabled ? undefined : NO_FULLSCREEN_TEXT
  const exitFullscreen = () => {
    if (fullscreenElementOf() === null) return
    document.exitFullscreen().catch(() => notice('退出全屏失败，请按 Esc 退出'))
  }
  const toggleFullscreen = () => {
    if (fullscreen) exitFullscreen()
    else if (fullscreenBlocked !== undefined) notice(fullscreenBlocked)
    else stage?.requestFullscreen().catch(() => notice('全屏打开失败，请重试'))
  }

  const total = film?.durationMs ?? 0
  const playhead = Math.min(playheadMs, total)
  const frameMs = Math.min(playhead, Math.max(0, total - 1))
  // 垫在预览后面的那一帧取最上面显示着的块：文件里写在后面的在上面
  const shown = pictures.findLast(
    (block) => !block.hidden && block.start <= frameMs && frameMs < block.start + block.duration,
  )
  const seek = (ms: number) => {
    leaveMaterial()
    setPlayheadMs(ms)
    previewRef.current?.seek(ms)
  }
  const togglePlay = () => {
    if (materialView !== null) {
      materialPreviewRef.current?.toggle()
      return
    }
    if (playing) previewRef.current?.pause()
    else previewRef.current?.play()
  }

  const rangeMaterial = range === null ? undefined : materials.byJob.get(range.jobId)
  const sizeUrl = film === null ? rangeMaterial?.url : undefined
  const size = useVideoSize(sizeUrl)
  const queryClient = useQueryClient()

  const [viewportWidth, setViewportWidth] = useState(0)
  const [zoom, setZoom] = useState<Zoom>(FIT_ZOOM)
  const scale = timelineScale(viewportWidth, total, zoom)
  const timelineRef = useRef<TimelineHandle | null>(null)
  const [ghost, setGhost] = useState<DropGhost | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  // 选中的块被撤销或删掉以后就不算选中了
  const selectedBlocks = pictures.filter((block) => selectedIds.has(block.id))
  const selected = new Set(selectedBlocks.map((block) => block.id))
  const clearSelection = () => setSelectedIds(new Set())
  // 框选、拖块中途的 Esc 归时间线（只取消那一次），这里先让开
  const [gesturing, setGesturing] = useState(false)
  // Esc 先退全屏（浏览器多半自己退，按键还是传到页面时才轮到这里），再取消选中；都没有才关编辑器
  useEscapeAheadOfDialog(fullscreen || (!gesturing && selected.size > 0), () => {
    if (fullscreen) exitFullscreen()
    else clearSelection()
  })
  const selectAround = (side: 'left' | 'right') =>
    setSelectedIds(new Set(aroundPlayhead(pictures, playhead, side)))
  const [scrollRequest, setScrollRequest] = useState<{ left: number } | null>(null)
  // 工具条上的缩放：播放头留在屏幕上原来的地方，看不见它时把它放到中间
  const zoomTo = (next: Zoom) => {
    const left = timelineRef.current?.scrollLeft() ?? 0
    const { pps } = timelineScale(viewportWidth, total, next)
    setZoom(next)
    setScrollRequest({ left: zoomScrollLeft(playhead, left, scale.pps, pps, viewportWidth) })
  }
  const zoomToSelection = () => {
    const target = zoomToBlocks(selectedBlocks, viewportWidth, scale.fitPps)
    if (target === null) return
    setZoom(target.zoom)
    setScrollRequest({ left: target.scrollLeft })
  }
  const [ripple, setRipple] = useState(true)
  const removeSelected = () => {
    leaveMaterial()
    clearSelection()
    session.removeBlocks([...selected], ripple)
  }
  const [thumbnails, setThumbnails] = useState(true)
  const [snap, setSnap] = useState(true)
  /** 拖着的素材会落在哪：开着吸附时先吸到别的块的两端或播放头上，再避开同一行的块。 */
  const landingAt = (clientX: number, clientY: number, dragged: MaterialRange) => {
    const point = timelineRef.current?.locate(clientX, clientY) ?? null
    if (point === null) return null
    const duration = dragged.endMs - dragged.startMs
    const snapped = snap
      ? snapSpanStartMs(point.timeMs, duration, snapTargets(pictures, playhead), scale.pps)
      : { ms: point.timeMs, guideMs: null }
    // 新开的一行上没有别的块，放在哪里都不会重叠
    const start =
      typeof point.row === 'number'
        ? landingOn(pictures, point.row, snapped.ms, duration).start
        : snapped.ms
    return {
      row: point.row,
      start,
      duration,
      guideMs: start === snapped.ms ? snapped.guideMs : null,
    }
  }

  /** `row` 这一行是几号；要新开一行时，连同别的块要换成的行号。`movedId` 是要搬过去的那个块。 */
  const trackFor = (row: RowTarget, movedId?: string) =>
    typeof row === 'number'
      ? { track: row, renumber: undefined }
      : rowOpening(pictures, row.insertAt, movedId)

  /** 把素材里的一段放进成片：给了 `at` 放在那里，没给就接在第一行的末尾。 */
  const place = (chosen: MaterialRange, at?: { row: RowTarget; start: number }) => {
    const material = materials.byJob.get(chosen.jobId)
    if (material === undefined) return
    const picked = rangePieces(chosen).map((piece) => {
      const shot = shotNumberOf(piece.mediaStart, material.url, keyframes)
      return {
        ...piece,
        jobId: material.jobId,
        src: material.url,
        label: `${takeLetterOf(material)} · ${shot === undefined ? material.version : `镜头 ${shot}`}`,
      }
    })
    const add = async (canvas: Canvas) => {
      const spot = at === undefined ? undefined : trackFor(at.row)
      const added = await session.addPictures(
        canvas,
        picked,
        spot === undefined || at === undefined ? undefined : { track: spot.track, start: at.start },
        spot?.renumber,
      )
      if (added) leaveMaterial()
    }
    if (film !== null) void add(film.canvas)
    else if (size.data !== undefined) void add(size.data)
    else
      void queryClient
        .fetchQuery(videoSizeQuery(material.url))
        .then(add, (error: unknown) =>
          notice(errorMessageOf(error, '画面尺寸读取失败，无法加入成片')),
        )
  }
  const insert = () => {
    if (range === null || rangeMaterial === undefined) notice(PICK_FIRST_TEXT)
    else place(range)
  }

  const history = {
    canUndo: film?.canUndo ?? false,
    canRedo: film?.canRedo ?? false,
    undo: session.undo,
    redo: session.redo,
  }
  const shortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || !isShortcutTarget(event)) return
    // 全屏时菜单挂在编辑器里面，菜单里按的键归菜单
    if (event.target instanceof Element && event.target.closest('[role="menu"]') !== null) return
    const { key } = event
    if (key === ' ') {
      event.preventDefault()
      togglePlay()
      return
    }
    const letter = event.altKey ? '' : key.toLowerCase()
    const toggle =
      letter === 'm' && !event.shiftKey
        ? toggleMute
        : letter === 'l' && event.shiftKey
          ? toggleLoop
          : letter === 'f' && !event.shiftKey
            ? toggleFullscreen
            : undefined
    if (toggle !== undefined) {
      event.preventDefault()
      if (!event.repeat) toggle()
      return
    }
    if ((key === 'Delete' || key === 'Backspace') && selected.size > 0) {
      event.preventDefault()
      removeSelected()
      return
    }
    if ((key === '[' || key === ']') && !event.altKey) {
      event.preventDefault()
      selectAround(key === '[' ? 'left' : 'right')
      return
    }
    if (letter === 'z' && !event.shiftKey) {
      event.preventDefault()
      if (!event.repeat) zoomToSelection()
      return
    }
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    if (event.target instanceof HTMLInputElement) return
    event.preventDefault()
    const stepMs = (key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1_000 : 100)
    seek(Math.min(total, Math.max(0, playhead + stepMs)))
  }
  useEffect(() => {
    keysRef.current = (event) => {
      // 拖块、框选进行中不接快捷键：这时撤销或删块，松手会按改之前算好的位置写回去
      if (gesturing) return
      handleUndoShortcut(event, history, leaveMaterial)
      if (event.key === 'Enter' && event.target === event.currentTarget) {
        event.preventDefault()
        insert()
        return
      }
      shortcut(event)
    }
    return () => {
      keysRef.current = null
    }
  })

  const srcdoc = useMemo(
    () =>
      film === null || film.pictures.length === 0
        ? undefined
        : previewDocument(film.html, catalog, window.location.origin),
    [film, catalog],
  )
  const playBlocked = srcdoc === undefined ? EMPTY_TEXT : undefined

  const exporting = useWholeFilmExport(conversationId, session.settle)
  const exportBlocked =
    pictures.length === 0 ? '成片里还没有画面，无法导出；请先加入素材片' : undefined

  const viewedMaterial =
    materialView === null ? undefined : materials.byJob.get(materialView.range.jobId)
  const materialLabel = (material: Material, viewed: MaterialRange) =>
    `素材 · ${material.groupLabel} · ${material.takeLabel}${shotsLabelOf(viewed, material.url, keyframes)}`
  const showMaterial = (viewed: MaterialRange, show: MaterialView['show']) => {
    previewRef.current?.pause()
    setRange(viewed)
    setMaterialView({ range: viewed, show })
  }

  if (session.opening)
    return (
      <>
        <EditorHeader actions={null} title={title} />
        <p className="wf-state" role="status">
          正在打开成片…
        </p>
      </>
    )

  return (
    <>
      <EditorHeader
        title={title}
        actions={
          <ExportControl
            blocked={exportBlocked}
            onCancel={() => void exporting.cancel()}
            onStart={() => void exporting.start()}
            view={exporting.view}
          />
        }
      />
      <div aria-label="成片编辑器" className="wf-workspace" role="group">
        <div className="wf-stage" ref={setStage}>
          <PreviewPlayer
            backdrop={shown === undefined ? undefined : videoSnapshotUrl(shown.src, 320)}
            controlRef={previewRef}
            height={film?.canvas.height ?? 1920}
            message={playBlocked}
            onBuffered={setBuffered}
            onBuffering={setBuffering}
            onPlaying={setPlaying}
            onTime={setPlayheadMs}
            playback={playback}
            srcdoc={srcdoc}
            width={film?.canvas.width ?? 1080}
          >
            {buffering ? <MediaBuffering /> : null}
          </PreviewPlayer>
          {viewedMaterial === undefined || materialView === null ? null : (
            <MaterialPreview
              controlRef={materialPreviewRef}
              label={materialLabel(viewedMaterial, materialView.range)}
              muted={playback.muted}
              onNotice={notice}
              onPlaying={setMaterialPlaying}
              onTime={setMaterialMs}
              rate={playback.rate}
              timeMs={materialMs}
              url={viewedMaterial.url}
              view={materialView}
            />
          )}
          <PreviewTransport
            buffered={buffered}
            fullscreen={fullscreen}
            fullscreenBlocked={fullscreenBlocked}
            layer={fullscreen ? stage : null}
            onFullscreen={toggleFullscreen}
            onLoop={toggleLoop}
            onMute={toggleMute}
            onPlay={togglePlay}
            onRate={(rate) => setPlayback((current) => ({ ...current, rate }))}
            onSeek={seek}
            playBlocked={materialView === null ? playBlocked : undefined}
            playback={playback}
            playheadMs={playhead}
            playing={materialView === null ? playing : materialPlaying}
            totalMs={total}
          />
        </div>
        <div className="wf-timeline">
          <EditorToolbar
            canRedo={history.canRedo}
            canUndo={history.canUndo}
            fitPps={scale.fitPps}
            onRedo={() => {
              leaveMaterial()
              session.redo()
            }}
            onUndo={() => {
              leaveMaterial()
              session.undo()
            }}
            hasSelection={selected.size > 0}
            onSelectAround={selectAround}
            onZoomToSelection={zoomToSelection}
            onRipple={() => setRipple((on) => !on)}
            onSnap={() => setSnap((on) => !on)}
            onThumbnails={() => setThumbnails((on) => !on)}
            onZoom={zoomTo}
            ripple={ripple}
            snap={snap}
            thumbnails={thumbnails}
            zoom={zoom}
          />
          <FilmTimeline
            buffered={buffered}
            ghost={ghost}
            handleRef={timelineRef}
            onHide={(track, hidden) => {
              leaveMaterial()
              session.setHidden(
                pictures.filter((block) => block.track === track).map((block) => block.id),
                hidden,
              )
            }}
            onRetime={(timings) => {
              leaveMaterial()
              session.retime(timings)
            }}
            onGesture={setGesturing}
            onSeek={seek}
            onSelect={setSelectedIds}
            onViewportWidth={setViewportWidth}
            pictures={pictures}
            playheadMs={playhead}
            scale={scale}
            onMove={(id, row, start, starts) => {
              const { track, renumber } = trackFor(row, id)
              leaveMaterial()
              session.moveBlock(id, { track, start }, renumber, starts)
            }}
            onRestart={(starts) => {
              leaveMaterial()
              session.restart(starts)
            }}
            scrollRequest={scrollRequest}
            selected={selected}
            snap={snap}
            thumbnails={thumbnails}
            sourceMs={(src) => {
              const state = keyframes.get(src)
              return state?.kind === 'ready' ? Math.round(state.index.duration * 1000) : undefined
            }}
            totalMs={total}
          />
          {session.save.kind === 'failed' ? (
            <InlineAlert
              action={{ label: '重新保存', onClick: session.flush }}
              message={session.save.message}
            />
          ) : null}
          <MaterialArea
            groups={materials.groups}
            keyframes={keyframes}
            onCarry={(carry) =>
              setGhost(carry === null ? null : landingAt(carry.clientX, carry.clientY, carry.range))
            }
            onDrop={(clientX, clientY, dropped) => {
              const at = landingAt(clientX, clientY, dropped)
              setGhost(null)
              if (at === null) return false
              place(dropped, { row: at.row, start: at.start })
              return true
            }}
            onInsert={insert}
            onClear={() => {
              setRange(null)
              leaveMaterial()
            }}
            onPick={(picked) => showMaterial(picked, 'start')}
            onSelect={setRange}
            onTrim={showMaterial}
            onVersion={(takeId, jobId) => {
              setPickedVersions((current) => ({ ...current, [takeId]: jobId }))
              if (range?.takeId !== takeId) return
              setRange(null)
              leaveMaterial()
            }}
            placeholder={
              videos.isError ? (
                <InlineAlert
                  action={{ label: '重试', onClick: () => void videos.refetch() }}
                  message={errorMessageOf(videos.error, '读取素材片失败')}
                />
              ) : videos.isPending ? (
                <p className="wf-panel-note" role="status">
                  正在读取素材片…
                </p>
              ) : undefined
            }
            playingMs={materialPlaying ? materialMs : undefined}
            range={range}
            used={usedSpans(pictures)}
            versionOf={versionOf}
          />
        </div>
      </div>
    </>
  )
}
