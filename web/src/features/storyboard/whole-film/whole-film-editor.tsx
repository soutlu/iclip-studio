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
import { useBrandProfiles } from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import type { WholeFilmDraftOut } from '@/shared/api/generated/types.gen'
import { Button } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { keyframeRanges } from '../editing/keyframe-segments'
import { useAudioPeaks } from '../editing/media-analysis'
import { handleUndoShortcut } from '../editing/undo-shortcut'
import { useStableValue } from '../editing/use-stable-value'
import { useShotGenerations } from '../storyboard.api'
import {
  itemOf,
  SHOW_ALL,
  transitionSpecs,
  useComponentCatalog,
  type ComponentFilter,
  type CatalogItem,
  type ComponentCatalog,
} from './component-catalog'
import { placeComponent } from './component-placement'
import { ComponentPopover } from './component-popover'
import { ComponentsPanel } from './components-panel'
import { placeCaptions, type PlacedCaption, type SubtitleRecord } from './composition/captions'
import { autoBeatSync } from './editing/beat-sync'
import { clearCaptionText, setCaptionText } from './editing/captions'
import type { ComponentVariables, VideoClip } from './editing/draft'
import {
  deleteClip,
  insertMaterial,
  setClipVolume,
  splitClip,
  type InsertAt,
} from './editing/layer0'
import { filmBeats, removeMusic, setMusicVolume } from './editing/music'
import { removeOverlay } from './editing/overlays'
import type { EditResult } from './editing/result'
import { cutsOf, filmDuration } from './editing/timeline'
import { removeTransition } from './editing/transitions'
import { setComponentVariables } from './editing/variables'
import {
  buildEditContext,
  useKeyframeIndexes,
  useVideoSize,
  withSourceSize,
  type KeyframeStates,
} from './edit-context'
import { EditorToolbar, SoundRow } from './editor-toolbar'
import { ExportControl } from './export-control'
import { FilmTracks, type DropTarget, type Selection } from './film-tracks'
import { MaterialArea, type MaterialRange } from './material-area'
import { materialCatalog, type Material, type MaterialTake } from './materials'
import { useMeasuredMusicDurations, useMusicAnalysis, useMusicBeats } from './music-analysis'
import { MusicPanel } from './music-panel'
import { musicTitleOf, peaksStateOf } from './music-view'
import { compositionMedia, previewState } from './preview-document'
import { PreviewPlayer, type PreviewControl } from './preview-player'
import { REFUSAL_TEXT } from './refusal-text'
import { FIT_ZOOM, nextZoom, timelineScale, type Zoom } from './timeline-scale'
import { useDraftSession } from './use-draft-session'
import { useWholeFilmExport } from './use-whole-film-export'
import {
  useConversationMusic,
  useConversationSubtitles,
  useWholeFilmDraftQuery,
} from './whole-film.api'
import './whole-film.css'

type Props = {
  conversationId: string
  onClose: () => void
}

type SideTab = 'materials' | 'components'

function EditorHeader({ actions }: { actions: ReactNode }) {
  return (
    <DialogHeader
      actions={actions}
      className="editor-header"
      closeLabel="关闭整片编辑"
      title={
        <span className="editor-title">
          <span>编辑视频</span>
          <span className="text-body-sm font-normal text-on-surface-muted">整片</span>
        </span>
      }
    />
  )
}

/** 整片编辑器：把这段对话的各条成片剪成一条整片，草稿自动存在服务端。 */
export function WholeFilmEditor({ conversationId, onClose }: Props) {
  const draftQuery = useWholeFilmDraftQuery(conversationId)
  const catalogQuery = useComponentCatalog()
  // 撤销快捷键挂在弹窗上，草稿读到之后由编辑区接上
  const undoKeysRef = useRef<((event: KeyboardEvent<HTMLDivElement>) => void) | null>(null)
  const failed = draftQuery.isError ? draftQuery : catalogQuery.isError ? catalogQuery : undefined
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogSurface
        aria-describedby={undefined}
        className="editor-dialog wf-dialog"
        onEscapeKeyDown={(event) => {
          // 字幕改字时 Esc 只放弃这次输入，不关编辑器
          if (event.target instanceof Element && event.target.closest('.wf-caption') !== null)
            event.preventDefault()
        }}
        // 打开时焦点落在弹窗本身：落在顶栏按钮上会直接弹出它的说明
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (event.target instanceof HTMLElement) event.target.focus()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => undoKeysRef.current?.(event)}
      >
        {draftQuery.data !== undefined && catalogQuery.data !== undefined ? (
          <EditorBody
            catalog={catalogQuery.data}
            conversationId={conversationId}
            initial={draftQuery.data}
            undoKeysRef={undoKeysRef}
          />
        ) : (
          <>
            <EditorHeader actions={null} />
            {failed !== undefined ? (
              <div className="wf-state">
                <InlineAlert
                  action={{ label: '重试', onClick: () => void failed.refetch() }}
                  message={errorMessageOf(
                    failed.error,
                    failed === draftQuery ? '整片草稿读取失败' : '组件库读取失败',
                  )}
                />
              </div>
            ) : (
              <p className="wf-state" role="status">
                正在读取整片草稿…
              </p>
            )}
          </>
        )}
      </DialogSurface>
    </DialogRoot>
  )
}

const takeLetterOf = (material: Material) => material.takeLabel.replace(/^生成\s*/, '')

const shotNumberOf = (clip: VideoClip, url: string, keyframes: KeyframeStates) => {
  const state = keyframes.get(url)
  if (state?.kind !== 'ready') return undefined
  const at = clip.playbackStart / 1000
  const index = keyframeRanges(state.index).findIndex(
    (shot) => at >= shot.start - 0.001 && at < shot.end,
  )
  return index < 0 ? undefined : index + 1
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

function EditorBody({
  conversationId,
  initial,
  catalog,
  undoKeysRef,
}: {
  conversationId: string
  initial: WholeFilmDraftOut
  catalog: ComponentCatalog
  undoKeysRef: RefObject<((event: KeyboardEvent<HTMLDivElement>) => void) | null>
}) {
  const notice = useCallback((message: string) => toast.info(message), [])
  const session = useDraftSession(conversationId, initial, { onNotice: notice })
  const { draft, apply } = session
  useEffect(() => {
    undoKeysRef.current = (event) => handleUndoShortcut(event, session)
    return () => {
      undoKeysRef.current = null
    }
  })

  const videos = useShotGenerations(conversationId)
  const materials = useMemo(
    () => materialCatalog(groupConversationVideos(videos.data ?? [])),
    [videos.data],
  )
  const [groupId, setGroupId] = useState<string>()
  const group = materials.groups.find((item) => item.id === groupId) ?? materials.groups[0]
  const [pickedVersions, setPickedVersions] = useState<Readonly<Record<string, string>>>({})
  const versionOf = (take: MaterialTake): Material =>
    take.versions.find((item) => item.jobId === pickedVersions[take.id]) ?? take.latest

  const sourceUrls = useStableValue(
    [
      ...new Set(
        draft.layer0.flatMap((clip) =>
          clip.type === 'video' ? (materials.byJob.get(clip.sourceJobId)?.url ?? []) : [],
        ),
      ),
    ].sort(),
  )
  const shownUrls = useStableValue(
    [
      ...new Set([...sourceUrls, ...(group?.takes.map((take) => versionOf(take).url) ?? [])]),
    ].sort(),
  )
  const keyframes = useKeyframeIndexes(shownUrls)
  const peaks = useAudioPeaks(sourceUrls)

  const music = useConversationMusic(conversationId)
  const subtitles = useConversationSubtitles(conversationId)
  const brands = useBrandProfiles().data?.items ?? []
  const unmeasured = useStableValue(
    (music.data ?? []).flatMap((job) =>
      job.status === 'completed' && job.outputUrl !== null && job.durationMs === null
        ? [job.outputUrl]
        : [],
    ),
  )
  const musicDurations = useMeasuredMusicDurations(unmeasured)
  const song = music.data?.find((job) => job.id === draft.music?.jobId)
  const songUrl = song?.outputUrl ?? undefined
  const songAnalysis = useMusicAnalysis(songUrl)
  const beats = useMusicBeats(songUrl)
  const transitions = useMemo(() => transitionSpecs(catalog), [catalog])

  const context = useMemo(
    () =>
      buildEditContext({
        materials: materials.byJob.values(),
        keyframes,
        subtitles: subtitles.data ?? [],
        music: music.data ?? [],
        musicDurations,
        beats:
          beats.kind === 'ready' && draft.music !== null
            ? { jobId: draft.music.jobId, beats: beats.beats }
            : undefined,
        transitions,
      }),
    [
      materials,
      keyframes,
      subtitles.data,
      music.data,
      musicDurations,
      beats,
      draft.music,
      transitions,
    ],
  )

  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const previewRef = useRef<PreviewControl | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [popoverId, setPopoverId] = useState<string | null>(null)
  const [sideTab, setSideTab] = useState<SideTab>('materials')
  const [filter, setFilter] = useState<ComponentFilter>(SHOW_ALL)
  const [snap, setSnap] = useState(true)
  const [zoom, setZoom] = useState<Zoom>(FIT_ZOOM)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [range, setRange] = useState<MaterialRange | null>(null)
  const dropTargetRef = useRef<DropTarget | null>(null)

  const total = filmDuration(draft)
  const scale = timelineScale(viewportWidth, total, zoom)
  const playhead = Math.min(playheadMs, total)
  const seek = (ms: number) => {
    setPlayheadMs(ms)
    previewRef.current?.seek(ms)
  }

  const rangeMaterial = range === null ? undefined : materials.byJob.get(range.jobId)
  const size = useVideoSize(draft.canvas === null ? rangeMaterial?.url : undefined)
  const addBlocked =
    range === null
      ? '先在下方点一个镜头选中范围'
      : context.sources[range.jobId] === undefined
        ? '正在读取素材时长，稍后再试'
        : draft.canvas !== null
          ? undefined
          : size.isError
            ? errorMessageOf(size.error, '画面尺寸读取失败，无法加入成片')
            : size.data === undefined
              ? '正在读取画面尺寸，稍后再试'
              : undefined

  const insert = (at: InsertAt) => {
    if (range === null || addBlocked !== undefined) return
    const withSize =
      draft.canvas === null && size.data !== undefined
        ? withSourceSize(context, range.jobId, size.data)
        : context
    apply(
      insertMaterial(
        draft,
        {
          sourceJobId: range.jobId,
          playbackStart: range.startMs,
          duration: range.endMs - range.startMs,
          at,
        },
        withSize,
      ),
    )
  }

  const selectedId = selection !== null && 'id' in selection ? selection.id : undefined
  const selectedVideo = draft.layer0.find(
    (clip): clip is VideoClip => clip.id === selectedId && clip.type === 'video',
  )
  const split = splitClip(
    draft,
    { timeMs: playhead, ...(selectedId === undefined ? {} : { clipId: selectedId }) },
    context,
  )
  const removeResult = (target: NonNullable<Selection>): EditResult =>
    target.kind === 'clip'
      ? deleteClip(draft, { clipId: target.id }, context)
      : target.kind === 'overlay'
        ? removeOverlay(draft, { overlayId: target.id })
        : target.kind === 'transition'
          ? removeTransition(draft, { transitionId: target.id })
          : removeMusic(draft)
  const remove = (target: Selection) => {
    if (target === null) return
    if (apply(removeResult(target))) {
      setSelection(null)
      setPopoverId(null)
    }
  }

  // 音乐列表与时长读到之前，编辑操作拿不到这首音乐的事实（时长、拍点）
  const musicKnown = draft.music !== null && context.music[draft.music.jobId] !== undefined
  const beatBlocked =
    draft.music === null
      ? REFUSAL_TEXT['no-music']
      : !musicKnown || beats.kind === 'loading'
        ? '正在分析这首音乐的拍点，稍后再试'
        : beats.kind === 'unavailable'
          ? beats.reason
          : undefined
  const beatSync = () => {
    const result = autoBeatSync(draft, context)
    if (!apply(result) || !result.ok) return
    toast.info(`已卡点 ${result.moved} 处，保留 ${result.kept} 处`)
  }

  // ---- 组件 ----
  const defaultBrand = brands[0]
  const componentTitle = (name: string) => itemOf(catalog, name)?.title ?? '组件库里没有的组件'
  // 点转场卡片放到哪个切点：选中的那一段后面（最后一段后面没有切点，由放转场那一步拒绝），或选中的转场所在处
  const cutAfterSelection = (): string | undefined =>
    selection?.kind === 'transition'
      ? draft.transitions.find((t) => t.id === selection.id)?.afterClipId
      : selection?.kind === 'clip'
        ? selection.id
        : undefined
  const placeFromCard = (item: CatalogItem) =>
    apply(
      placeComponent(
        draft,
        item,
        { via: 'click', playheadMs: playhead, cutAfterClipId: cutAfterSelection() },
        { context, brand: defaultBrand },
      ),
    )
  const dropComponent = (item: CatalogItem, clientX: number, clientY: number) => {
    const target = dropTargetRef.current?.(clientX, clientY)
    if (target === undefined) return
    apply(placeComponent(draft, item, { via: 'drop', ...target }, { context, brand: defaultBrand }))
  }

  const renderPopover = (id: string): ReactNode => {
    const clip = draft.layer0.find((item) => item.id === id && item.type === 'component')
    const overlay = draft.overlays.find((item) => item.id === id)
    const transition = draft.transitions.find((item) => item.id === id)
    const target =
      clip?.type === 'component'
        ? {
            component: clip.component,
            variables: clip.variables,
            heading: `${clip.role === 'intro' ? '片头' : '片尾'} · ${componentTitle(clip.component)}`,
            meta: `${seconds(clip.duration)} 秒 · ${clip.role === 'intro' ? '拖右边缘' : '拖左边缘'}改时长`,
            removeLabel: clip.role === 'intro' ? '移除片头' : '移除片尾',
            selection: { kind: 'clip', id } as const,
          }
        : overlay !== undefined
          ? {
              component: overlay.component,
              variables: overlay.variables,
              heading: componentTitle(overlay.component),
              meta: `${seconds(overlay.start)}–${seconds(overlay.start + overlay.duration)} 秒 · 拖两端改起止`,
              removeLabel: '移除',
              selection: { kind: 'overlay', id } as const,
            }
          : transition !== undefined
            ? {
                component: transition.component,
                variables: transition.variables,
                heading: componentTitle(transition.component),
                meta: `转场 · ${seconds(cutsOf(draft).find((cut) => cut.afterClipId === transition.afterClipId)?.timeMs ?? 0)} 秒处`,
                removeLabel: '移除',
                selection: { kind: 'transition', id } as const,
              }
            : undefined
    if (target === undefined) return null
    const item = itemOf(catalog, target.component)
    if (item === undefined)
      return (
        <div className="wf-pop">
          <p className="wf-pop-desc">{REFUSAL_TEXT['unknown-component']}</p>
          <Button onClick={() => remove(target.selection)} size="md" variant="outlined">
            {target.removeLabel}
          </Button>
        </div>
      )
    return (
      <ComponentPopover
        brands={brands}
        heading={target.heading}
        item={item}
        meta={target.meta}
        onChange={(variables: ComponentVariables) =>
          apply(setComponentVariables(draft, { id, variables }))
        }
        onRemove={() => remove(target.selection)}
        removeLabel={target.removeLabel}
        values={target.variables}
      />
    )
  }

  // ---- 字幕 ----
  const subtitleRecords = useMemo(() => {
    const records: Record<string, SubtitleRecord | null> = {}
    for (const [jobId, source] of Object.entries(context.sources)) records[jobId] = source.subtitle
    return records
  }, [context.sources])
  const captions = useMemo(() => placeCaptions(draft, subtitleRecords), [draft, subtitleRecords])
  const recognized = (caption: PlacedCaption) =>
    Object.values(subtitleRecords).find((record) => record?.subtitleJobId === caption.subtitleJobId)
      ?.sentences[caption.sentenceIndex]?.text ?? caption.text
  const sentenceText = (caption: PlacedCaption) =>
    draft.captions.edits.find(
      (edit) =>
        edit.subtitleJobId === caption.subtitleJobId &&
        edit.sentenceIndex === caption.sentenceIndex,
    )?.text ?? recognized(caption)
  const editCaption = (caption: PlacedCaption, text: string) => {
    const sentence = { subtitleJobId: caption.subtitleJobId, sentenceIndex: caption.sentenceIndex }
    const trimmed = text.trim()
    apply(
      trimmed === '' || trimmed === recognized(caption)
        ? clearCaptionText(draft, sentence)
        : setCaptionText(draft, { ...sentence, text: trimmed }),
    )
  }

  // ---- 预览 ----（React Compiler 按草稿与素材缓存，播放头走动时不重新生成）
  const preview = previewState(
    draft,
    compositionMedia(draft, {
      videoUrl: (jobId) => materials.byJob.get(jobId)?.url,
      musicUrl: songUrl,
      subtitles: subtitleRecords,
    }),
    catalog,
    window.location.origin,
  )
  const playBlocked = preview.kind === 'blocked' ? preview.message : undefined

  // ---- 导出 ----
  const exporting = useWholeFilmExport(conversationId, session.settle)
  const exportBlocked = !draft.layer0.some((clip) => clip.type === 'video')
    ? '成片里还没有画面，无法导出；请先加入视频'
    : undefined

  const clipLabel = (clip: VideoClip) => {
    const material = materials.byJob.get(clip.sourceJobId)
    if (material === undefined) return '素材不在了'
    const shot = shotNumberOf(clip, material.url, keyframes)
    return shot === undefined
      ? `${takeLetterOf(material)} · ${material.version}`
      : `${takeLetterOf(material)} · 镜头 ${shot}`
  }

  const videoIndex =
    selectedVideo === undefined
      ? -1
      : draft.layer0.filter((clip) => clip.type === 'video').indexOf(selectedVideo)

  return (
    <>
      <EditorHeader
        actions={
          <ExportControl
            blocked={exportBlocked}
            onCancel={() => void exporting.cancel()}
            onDownload={exporting.recordDownload}
            onStart={() => void exporting.start()}
            view={exporting.view}
          />
        }
      />
      <div aria-label="整片编辑器" className="wf-workspace" role="group">
        <TabsRoot
          className="wf-side"
          onValueChange={(value) => setSideTab(value as SideTab)}
          value={sideTab}
        >
          <TabsList aria-label="素材与组件" className="wf-side-tabs">
            <TabsTrigger value="materials">素材</TabsTrigger>
            <TabsTrigger value="components">组件</TabsTrigger>
          </TabsList>
          <TabsContent className="wf-side-body" value="materials">
            <MusicPanel
              apply={apply}
              context={context}
              conversationId={conversationId}
              draft={draft}
              onNotice={notice}
            />
          </TabsContent>
          <TabsContent className="wf-side-body is-components" value="components">
            <ComponentsPanel
              catalog={catalog}
              filter={filter}
              draft={draft}
              onFilter={setFilter}
              onDrop={dropComponent}
              onUse={placeFromCard}
            />
          </TabsContent>
        </TabsRoot>
        <PreviewPlayer
          controlRef={previewRef}
          height={draft.canvas?.height ?? 1920}
          message={playBlocked}
          onPlaying={setPlaying}
          onTime={setPlayheadMs}
          srcdoc={preview.kind === 'ready' ? preview.html : undefined}
          width={draft.canvas?.width ?? 1080}
        />
        <div className="wf-timeline">
          <EditorToolbar
            canRedo={session.canRedo}
            canUndo={session.canUndo}
            deleteBlocked={selection === null ? '先选中要删除的片段' : undefined}
            onDelete={() => remove(selection)}
            onFit={() => setZoom(FIT_ZOOM)}
            onPlay={() => (playing ? previewRef.current?.pause() : previewRef.current?.play())}
            onRedo={session.redo}
            onSnap={() => setSnap((value) => !value)}
            onSplit={() => {
              if (apply(split) && split.ok) setSelection(null)
            }}
            onUndo={session.undo}
            onZoom={(direction) => setZoom(nextZoom(direction, zoom, scale.fitPps))}
            playBlocked={playBlocked}
            playheadMs={playhead}
            playing={playing}
            snap={snap}
            splitBlocked={split.ok ? undefined : REFUSAL_TEXT[split.refusal]}
            totalMs={total}
          />
          <SoundRow
            beatBlocked={beatBlocked}
            clipText={videoIndex < 0 ? '选择片段可调原声' : `当前片段 · 第 ${videoIndex + 1} 段`}
            clipVolume={selectedVideo?.volume}
            musicVolume={draft.music?.volume}
            onBeatSync={beatSync}
            onClipVolume={(volume) => {
              if (selectedVideo !== undefined)
                apply(setClipVolume(draft, { clipId: selectedVideo.id, volume }))
            }}
            onMusicVolume={(volume) => apply(setMusicVolume(draft, { volume }))}
          />
          {session.save.kind === 'failed' ? (
            <InlineAlert
              action={{ label: '重新保存', onClick: session.flush }}
              message={session.save.message}
            />
          ) : null}
          <FilmTracks
            apply={apply}
            beats={musicKnown ? filmBeats(draft, context) : []}
            captionStyle={componentTitle(draft.captions.component)}
            captions={captions}
            clipLabel={clipLabel}
            componentTitle={componentTitle}
            context={context}
            draft={draft}
            dropTargetRef={dropTargetRef}
            music={
              song === undefined || songUrl === undefined
                ? undefined
                : { url: songUrl, title: musicTitleOf(song), peaks: peaksStateOf(songAnalysis) }
            }
            onAddEndCard={(placement) => {
              setSideTab('components')
              setFilter({ kind: 'placement', placement })
            }}
            onCaptionStyle={() => {
              setSideTab('components')
              setFilter({ kind: 'category', id: 'captions' })
            }}
            onCaptionText={editCaption}
            onSeek={seek}
            onSelect={(next) => {
              setSelection(next)
              if (next === null) setPopoverId(null)
            }}
            onViewportWidth={setViewportWidth}
            peaks={peaks}
            playheadMs={playhead}
            popovers={{ openId: popoverId, onOpen: setPopoverId, render: renderPopover }}
            scale={scale}
            selection={selection}
            sentenceText={sentenceText}
            snap={snap}
            urlOf={(sourceJobId) => materials.byJob.get(sourceJobId)?.url}
          />
          {videos.isError ? (
            <InlineAlert
              action={{ label: '重试', onClick: () => void videos.refetch() }}
              message={errorMessageOf(videos.error, '读取成片失败')}
            />
          ) : videos.isPending ? (
            <p className="wf-panel-note" role="status">
              正在读取成片…
            </p>
          ) : (
            <MaterialArea
              addBlocked={addBlocked}
              group={group}
              groups={materials.groups}
              keyframes={keyframes}
              onAdd={() => insert({ videoIndex: Number.MAX_SAFE_INTEGER })}
              onDrop={(clientX, clientY) => {
                const target = dropTargetRef.current?.(clientX, clientY)
                if (target === undefined) return false
                insert({ timeMs: target.timeMs })
                return true
              }}
              onGroup={(id) => {
                setGroupId(id)
                setRange(null)
              }}
              onRange={setRange}
              onVersion={(takeId, jobId) => {
                setPickedVersions((current) => ({ ...current, [takeId]: jobId }))
                if (range?.takeId === takeId) setRange(null)
              }}
              range={range}
              versionOf={versionOf}
            />
          )}
        </div>
      </div>
    </>
  )
}
