import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import type { WholeFilmDraftOut } from '@/shared/api/generated/types.gen'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
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
import { previewDocument } from './preview-document'
import { PreviewPlayer, type PreviewControl } from './preview-player'
import { PreviewTransport } from './preview-transport'
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

  const total = film?.durationMs ?? 0
  const playhead = Math.min(playheadMs, total)
  const frameMs = Math.min(playhead, Math.max(0, total - 1))
  const shown = pictures.find(
    (block) => block.start <= frameMs && frameMs < block.start + block.duration,
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

  const insert = () => {
    if (range === null || rangeMaterial === undefined) {
      notice(PICK_FIRST_TEXT)
      return
    }
    const material = rangeMaterial
    const picked = rangePieces(range).map((piece) => {
      const shot = shotNumberOf(piece.mediaStart, material.url, keyframes)
      return {
        ...piece,
        jobId: material.jobId,
        src: material.url,
        label: `${takeLetterOf(material)} · ${shot === undefined ? material.version : `镜头 ${shot}`}`,
      }
    })
    const add = async (canvas: Canvas) => {
      if (await session.addPictures(canvas, picked)) leaveMaterial()
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

  const history = {
    canUndo: film?.canUndo ?? false,
    canRedo: film?.canRedo ?? false,
    undo: session.undo,
    redo: session.redo,
  }
  const shortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || !isShortcutTarget(event)) return
    const { key } = event
    if (key === ' ') {
      event.preventDefault()
      togglePlay()
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
        <PreviewPlayer
          backdrop={shown === undefined ? undefined : videoSnapshotUrl(shown.src, 320)}
          controlRef={previewRef}
          height={film?.canvas.height ?? 1920}
          message={playBlocked}
          onBuffered={setBuffered}
          onBuffering={setBuffering}
          onPlaying={setPlaying}
          onTime={setPlayheadMs}
          srcdoc={srcdoc}
          width={film?.canvas.width ?? 1080}
        >
          {buffering ? <MediaBuffering /> : null}
        </PreviewPlayer>
        {viewedMaterial === undefined || materialView === null ? null : (
          <MaterialPreview
            controlRef={materialPreviewRef}
            label={materialLabel(viewedMaterial, materialView.range)}
            onNotice={notice}
            onPlaying={setMaterialPlaying}
            onTime={setMaterialMs}
            timeMs={materialMs}
            url={viewedMaterial.url}
            view={materialView}
          />
        )}
        <PreviewTransport
          buffered={buffered}
          onPlay={togglePlay}
          onSeek={seek}
          playBlocked={materialView === null ? playBlocked : undefined}
          playheadMs={playhead}
          playing={materialView === null ? playing : materialPlaying}
          totalMs={total}
        />
        <div className="wf-timeline">
          <EditorToolbar
            canRedo={history.canRedo}
            canUndo={history.canUndo}
            insertBlocked={range === null ? PICK_FIRST_TEXT : undefined}
            onInsert={insert}
            onRedo={() => {
              leaveMaterial()
              session.redo()
            }}
            onUndo={() => {
              leaveMaterial()
              session.undo()
            }}
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
            onCarry={() => undefined}
            onDrop={() => false}
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
