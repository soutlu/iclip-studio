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
import { Button } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { keyframeRanges } from '../editing/keyframe-segments'
import { useAudioPeaks } from '../editing/media-analysis'
import { Frames } from '../editing/timeline'
import { handleUndoShortcut } from '../editing/undo-shortcut'
import { useStableValue } from '../editing/use-stable-value'
import { useShotGenerations } from '../storyboard.api'
import {
  brandGroups,
  CATEGORY_ICON,
  categoryGroups,
  durationMsOf,
  itemOf,
  thumbnailOf,
  useComponentCatalog,
  type CatalogItem,
  type ComponentCatalog,
} from './component-catalog'
import { placeComponent, placedPiece, type Placing } from './component-placement'
import { ComponentPopover } from './component-popover'
import { ComponentsPanel, ComponentThumb, type CardCarry } from './components-panel'
import { DEFAULT_CANVAS } from './composition/build'
import { placeCaptions, type PlacedCaption, type SubtitleRecord } from './composition/captions'
import { autoBeatSync } from './editing/beat-sync'
import { clearCaptionText, setCaptionText } from './editing/captions'
import {
  MAX_FILM_MS,
  type ComponentVariables,
  type Layer0Clip,
  type VideoClip,
} from './editing/draft'
import {
  deleteClip,
  insertMaterial,
  moveClip,
  setClipVolume,
  splitClip,
  type InsertAt,
} from './editing/layer0'
import { filmBeats, removeMusic, setMusicVolume } from './editing/music'
import { moveOverlay, removeOverlay } from './editing/overlays'
import type { EditResult } from './editing/result'
import { filmDuration } from './editing/timeline'
import { setComponentVariables } from './editing/variables'
import {
  buildEditContext,
  useKeyframeIndexes,
  useVideoSize,
  videoSizeQuery,
  withSourceSize,
  type KeyframeStates,
} from './edit-context'
import { EditorToolbar, SoundRow } from './editor-toolbar'
import { ExportControl } from './export-control'
import {
  FilmTracks,
  type Attempt,
  type CarryPayload,
  type ComponentFace,
  type DropPoint,
  type Selection,
  type TracksHandle,
} from './film-tracks'
import { MaterialArea, type MaterialCarry } from './material-area'
import { MaterialPreview, type MaterialPreviewControl, type MaterialView } from './material-preview'
import {
  materialCatalog,
  shotAt,
  usedSpans,
  type Material,
  type MaterialRange,
  type MaterialTake,
} from './materials'
import { useMeasuredMusicDurations, useMusicAnalysis, useMusicBeats } from './music-analysis'
import { MusicAction, MusicPanel } from './music-panel'
import { musicTitleOf, peaksStateOf } from './music-view'
import { compositionMedia, previewState } from './preview-document'
import { PreviewPlayer, type PreviewControl } from './preview-player'
import { FILM_LIMIT_TEXT, REFUSAL_TEXT } from './refusal-text'
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

type SideTab = 'materials' | 'brand' | 'general'

/** 品牌栏、通用栏各自选中的小标题；没选过为 undefined，取第一个 */
type SideChips = Readonly<Record<'brand' | 'general', string | undefined>>

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
  // 快捷键挂在弹窗上，草稿读到之后由编辑区接上
  const keysRef = useRef<((event: KeyboardEvent<HTMLDivElement>) => void) | null>(null)
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
        onKeyDown={(event) => keysRef.current?.(event)}
      >
        {draftQuery.data !== undefined && catalogQuery.data !== undefined ? (
          <EditorBody
            catalog={catalogQuery.data}
            conversationId={conversationId}
            initial={draftQuery.data}
            keysRef={keysRef}
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

/** 素材里 ms 这一刻是第几个镜头；镜头表还没读到时 undefined */
const shotNumberOf = (ms: number, url: string, keyframes: KeyframeStates) => {
  const state = keyframes.get(url)
  return state?.kind === 'ready' ? shotAt(keyframeRanges(state.index), ms / 1000) : undefined
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

const isTextEntry = (target: HTMLElement) =>
  target.isContentEditable ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement && target.type !== 'range')

/**
 * 编辑器的单键快捷键只在弹窗里、不在打字时生效；组件浮层与菜单挂在弹窗外，标签页的方向键与空格
 * 留给标签页自己。
 */
const isShortcutTarget = (event: KeyboardEvent<HTMLDivElement>) =>
  event.target instanceof HTMLElement &&
  event.currentTarget.contains(event.target) &&
  !isTextEntry(event.target) &&
  event.target.closest('[role="tab"]') === null

const attemptOf = (result: EditResult): Attempt =>
  result.ok ? result : { ok: false, reason: REFUSAL_TEXT[result.refusal] }

function EditorBody({
  conversationId,
  initial,
  catalog,
  keysRef,
}: {
  conversationId: string
  initial: WholeFilmDraftOut
  catalog: ComponentCatalog
  keysRef: RefObject<((event: KeyboardEvent<HTMLDivElement>) => void) | null>
}) {
  const notice = useCallback((message: string) => toast.info(message), [])
  const session = useDraftSession(conversationId, initial, { onNotice: notice })
  const { draft } = session
  const [materialView, setMaterialView] = useState<MaterialView | null>(null)
  const [materialMs, setMaterialMs] = useState(0)
  const [materialPlaying, setMaterialPlaying] = useState(false)
  const materialPreviewRef = useRef<MaterialPreviewControl | null>(null)
  // 拖播放头、点成片轨或做成片编辑时回到成片；播放暂停控制当前预览。
  const leaveMaterial = () => {
    setMaterialView(null)
    setMaterialPlaying(false)
  }
  const apply = (result: EditResult) => {
    leaveMaterial()
    return session.apply(result)
  }

  const videos = useShotGenerations(conversationId)
  const materials = useMemo(
    () => materialCatalog(groupConversationVideos(videos.data ?? [])),
    [videos.data],
  )
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
      ...new Set([
        ...sourceUrls,
        ...materials.groups.flatMap((group) => group.takes.map((take) => versionOf(take).url)),
      ]),
    ].sort(),
  )
  const keyframes = useKeyframeIndexes(shownUrls)
  const peaks = useAudioPeaks(sourceUrls)

  const music = useConversationMusic(conversationId)
  const subtitles = useConversationSubtitles(conversationId)
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
      }),
    [materials, keyframes, subtitles.data, music.data, musicDurations, beats, draft.music],
  )

  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const previewRef = useRef<PreviewControl | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [popoverId, setPopoverId] = useState<string | null>(null)
  const [sideTab, setSideTab] = useState<SideTab>('materials')
  const [sideChips, setSideChips] = useState<SideChips>({ brand: undefined, general: undefined })
  const [snap, setSnap] = useState(true)
  const [zoom, setZoom] = useState<Zoom>(FIT_ZOOM)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [range, setRange] = useState<MaterialRange | null>(null)
  const tracksRef = useRef<TracksHandle | null>(null)
  // 点成片段后只播这一段：播到这一刻停住；拖动播放头或再按播放时取消
  const stopAtRef = useRef<number | null>(null)

  const total = filmDuration(draft)
  const scale = timelineScale(viewportWidth, total, zoom)
  const playhead = Math.min(playheadMs, total)
  const seek = (ms: number) => {
    stopAtRef.current = null
    leaveMaterial()
    setPlayheadMs(ms)
    previewRef.current?.seek(ms)
  }
  const onTime = (ms: number) => {
    setPlayheadMs(ms)
    const stopAt = stopAtRef.current
    if (stopAt !== null && ms >= stopAt) {
      stopAtRef.current = null
      previewRef.current?.pause()
    }
  }
  const togglePlay = () => {
    if (materialView !== null) {
      materialPreviewRef.current?.toggle()
      return
    }
    stopAtRef.current = null
    if (playing) previewRef.current?.pause()
    else previewRef.current?.play()
  }
  /** 点成片段：选中，播放头移到段首并把这一段播一遍 */
  const playClip = (clip: Layer0Clip) => {
    setSelection({ kind: 'clip', id: clip.id })
    seek(clip.start)
    stopAtRef.current = clip.start + clip.duration
    previewRef.current?.play()
  }

  const rangeMaterial = range === null ? undefined : materials.byJob.get(range.jobId)
  // 画布还没定时，第一段视频的画面尺寸定画布：选中镜头就开始读
  const sizeUrl = draft.canvas === null ? rangeMaterial?.url : undefined
  const size = useVideoSize(sizeUrl)
  const queryClient = useQueryClient()

  // 拖动中能不能放：素材时长没读到、画面尺寸读取失败时写原因；尺寸还在读不拦，插入时等它读到
  const addBlocked =
    range === null
      ? '先在下方点一个镜头选中范围'
      : context.sources[range.jobId] === undefined
        ? '正在读取素材时长，稍后再试'
        : draft.canvas === null && size.isError
          ? errorMessageOf(size.error, '画面尺寸读取失败，无法加入成片')
          : undefined

  /** 把 picked 插到 at；画布还没定时 sourceSize 是这条素材的画面尺寸 */
  const insertResult = (
    picked: MaterialRange,
    at: InsertAt,
    sourceSize: { width: number; height: number } | undefined = size.data,
  ) =>
    insertMaterial(
      draft,
      {
        sourceJobId: picked.jobId,
        playbackStart: picked.startMs,
        duration: picked.endMs - picked.startMs,
        at,
      },
      draft.canvas === null && sourceSize !== undefined
        ? withSourceSize(context, picked.jobId, sourceSize)
        : context,
    )
  // 画面尺寸读到时已经过了几次渲染：用那时的草稿插
  const insertResultRef = useRef(insertResult)
  useEffect(() => {
    insertResultRef.current = insertResult
  })

  const insert = (at: InsertAt): boolean => {
    if (addBlocked !== undefined || range === null) {
      notice(addBlocked ?? '先在下方点一个镜头选中范围')
      return false
    }
    if (draft.canvas !== null || size.data !== undefined) return apply(insertResult(range, at))
    // 画面尺寸还在读：等读到再插，不让人重按
    const picked = range
    void queryClient.fetchQuery(videoSizeQuery(sizeUrl)).then(
      (read) => apply(insertResultRef.current(picked, at, read)),
      (error: unknown) => notice(errorMessageOf(error, '画面尺寸读取失败，无法加入成片')),
    )
    return true
  }

  /** 拖着素材区选中的范围 picked：落在成片轨上插到最近的切点 */
  const materialPayload = (
    picked: MaterialRange,
    origin?: MaterialCarry['origin'],
  ): CarryPayload | undefined => {
    const material = materials.byJob.get(picked.jobId)
    if (material === undefined) return undefined
    const duration = picked.endMs - picked.startMs
    const shot = shotNumberOf((picked.startMs + picked.endMs) / 2, material.url, keyframes)
    const blocked =
      context.sources[picked.jobId] === undefined ? '正在读取素材时长，稍后再试' : undefined
    return {
      durationMs: duration,
      ghost:
        origin === undefined
          ? undefined
          : {
              origin,
              body: (
                <>
                  <span className="wf-ghost-frames">
                    <Frames
                      part={{
                        mediaUrl: material.url,
                        start: picked.startMs / 1000,
                        end: picked.endMs / 1000,
                      }}
                    />
                  </span>
                  <span className="wf-clip-label">
                    {takeLetterOf(material)}
                    {shot === undefined ? '' : ` · 镜头 ${shot}`} · {seconds(duration)} 秒
                  </span>
                </>
              ),
            },
      attempt: (point) => {
        if (point.lane !== 'film') return undefined
        if (blocked !== undefined) return { ok: false, reason: blocked }
        return attemptOf(insertResult(picked, { timeMs: point.timeMs }))
      },
      drop: (point) => point.lane === 'film' && insert({ timeMs: point.timeMs }),
    }
  }

  // 撤销、重做也是成片编辑：预览回到成片
  const undo = () => {
    leaveMaterial()
    session.undo()
  }
  const redo = () => {
    leaveMaterial()
    session.redo()
  }

  const selectedId = selection !== null && 'id' in selection ? selection.id : undefined
  const selectedVideo = draft.layer0.find(
    (clip): clip is VideoClip => clip.id === selectedId && clip.type === 'video',
  )
  const split = splitClip(draft, {
    timeMs: playhead,
    ...(selectedId === undefined ? {} : { clipId: selectedId }),
  })
  const removeResult = (target: NonNullable<Selection>): EditResult =>
    target.kind === 'clip'
      ? deleteClip(draft, { clipId: target.id })
      : target.kind === 'overlay'
        ? removeOverlay(draft, { overlayId: target.id })
        : removeMusic(draft)
  const remove = (target: Selection) => {
    if (target === null) return
    if (apply(removeResult(target))) {
      setSelection(null)
      setPopoverId(null)
    }
  }

  /**
   * 单键快捷键：空格播放、暂停；Delete / ⌫ 删除选中的；⌥←/→ 把选中的段前后挪一位；选中特效块时
   * ←/→ 把它挪 0.1 秒（⇧ 1 秒），否则播放头走 0.1 秒（⇧ 1 秒）。修剪手柄、音量推子自己处理方向键。
   */
  const shortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || !isShortcutTarget(event)) return
    const { key } = event
    if (key === ' ') {
      event.preventDefault()
      togglePlay()
      return
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault()
      remove(selection)
      return
    }
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    // 刻度尺上的定位滑块自己走播放头
    if (event.target instanceof HTMLInputElement) return
    event.preventDefault()
    const sign = key === 'ArrowLeft' ? -1 : 1
    const stepMs = event.shiftKey ? 1_000 : 100
    if (event.altKey) {
      if (selection?.kind !== 'clip') return
      const from = draft.layer0.findIndex((clip) => clip.id === selection.id)
      if (apply(moveClip(draft, { clipId: selection.id, to: sign < 0 ? from - 1 : from + 2 })))
        tracksRef.current?.focusClip(selection.id)
      return
    }
    if (selection?.kind === 'overlay') {
      const overlay = draft.overlays.find((item) => item.id === selection.id)
      if (overlay === undefined) return
      const result = moveOverlay(draft, { overlayId: overlay.id, deltaMs: sign * stepMs })
      if (result.ok && result.draft !== draft) apply(result)
      else if (sign > 0 && overlay.start + overlay.duration + stepMs > MAX_FILM_MS)
        notice(FILM_LIMIT_TEXT)
      else if (sign > 0 || overlay.start > 0) notice('这一行旁边没有空位，挪不动了')
      return
    }
    seek(Math.min(total, Math.max(0, playhead + sign * stepMs)))
  }
  useEffect(() => {
    keysRef.current = (event) => {
      handleUndoShortcut(event, session, leaveMaterial)
      // 焦点不在任何控件上时（落在弹窗本身），Enter 把选区插到播放头处
      if (event.key === 'Enter' && event.target === event.currentTarget) {
        event.preventDefault()
        insert({ timeMs: playhead })
        return
      }
      shortcut(event)
    }
    return () => {
      keysRef.current = null
    }
  })

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
  const componentFace = (name: string): ComponentFace => {
    const item = itemOf(catalog, name)
    return {
      title: item?.title ?? '组件库里没有的组件',
      thumbnail: item === undefined ? undefined : thumbnailOf(item),
      icon: (item === undefined ? undefined : CATEGORY_ICON[item.category]) ?? 'grid',
    }
  }
  const componentTitle = (name: string) => componentFace(name).title
  /** 放进成片后选中新的组件段或特效块；有可填项就打开它的浮层 */
  const place = (item: CatalogItem, placing: Placing): boolean => {
    const result = placeComponent(draft, item, placing)
    if (!apply(result) || !result.ok) return false
    const placed = placedPiece(draft, result.draft)
    if (placed !== undefined) {
      setSelection(placed)
      setPopoverId(item.variables.length > 0 ? placed.id : null)
    }
    return true
  }
  const placeFromCard = (item: CatalogItem) => place(item, { via: 'click', playheadMs: playhead })
  const dropAt = (point: DropPoint): Placing => ({
    via: 'drop',
    lane: point.lane,
    timeMs: point.timeMs,
    overlayRow: point.overlayRow,
  })
  /**
   * 拖着组件卡：落在哪条轨就是哪种用法；字幕样式只落在字幕轨，音乐轨不收组件。
   * 手上的缩影是预览图加名字的小条，拿起时的卡片位置是它退回的地方。
   */
  const componentPayload = (item: CatalogItem, origin?: CardCarry['origin']): CarryPayload => ({
    durationMs: durationMsOf(item, total),
    face: componentFace(item.name),
    ghost:
      origin === undefined
        ? undefined
        : {
            origin,
            kind: 'card',
            body: (
              <>
                <ComponentThumb className="wf-ghost-thumb" iconSize="xs" item={item} />
                <b>{item.title}</b>
              </>
            ),
          },
    attempt: (point) => {
      const result = placeComponent(draft, item, dropAt(point))
      return !result.ok && result.refusal === 'drop-elsewhere' ? undefined : attemptOf(result)
    },
    drop: (point) => place(item, dropAt(point)),
  })
  const carryComponent = (item: CatalogItem, carry: CardCarry | null) => {
    if (carry === null) tracksRef.current?.cancel()
    else
      tracksRef.current?.carry(carry.clientX, carry.clientY, componentPayload(item, carry.origin))
  }
  const dropComponent = (item: CatalogItem, carry: CardCarry) =>
    tracksRef.current?.release(carry.clientX, carry.clientY, componentPayload(item, carry.origin))
  const hasFields = (name: string) => {
    const item = itemOf(catalog, name)
    return item === undefined || item.variables.length > 0
  }

  const renderPopover = (id: string): ReactNode => {
    const clip = draft.layer0.find((item) => item.id === id && item.type === 'component')
    const overlay = draft.overlays.find((item) => item.id === id)
    const target =
      clip?.type === 'component'
        ? {
            component: clip.component,
            variables: clip.variables,
            selection: { kind: 'clip', id } as const,
          }
        : overlay !== undefined
          ? {
              component: overlay.component,
              variables: overlay.variables,
              selection: { kind: 'overlay', id } as const,
            }
          : undefined
    if (target === undefined) return null
    const item = itemOf(catalog, target.component)
    if (item === undefined)
      return (
        <div className="wf-pop">
          <p className="wf-pop-desc">组件库里没有这个组件，无法使用</p>
          <Button onClick={() => remove(target.selection)} size="md" variant="outlined">
            移除
          </Button>
        </div>
      )
    return (
      <ComponentPopover
        item={item}
        onChange={(variables: ComponentVariables) =>
          apply(setComponentVariables(draft, { id, variables }))
        }
        onRemove={() => remove(target.selection)}
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
  const exportBlocked =
    draft.layer0.length === 0 ? '成片里还没有画面，无法导出；请先加入视频或组件' : undefined

  const clipLabel = (clip: VideoClip) => {
    const material = materials.byJob.get(clip.sourceJobId)
    if (material === undefined) return '素材不在了'
    const shot = shotNumberOf(clip.playbackStart, material.url, keyframes)
    return shot === undefined
      ? `${takeLetterOf(material)} · ${material.version}`
      : `${takeLetterOf(material)} · 镜头 ${shot}`
  }

  const selectedIndex = draft.layer0.findIndex((clip) => clip.id === selectedId)
  const clipText =
    selectedIndex < 0 ? (
      '选择片段可调原声'
    ) : (
      <>
        当前片段 · <b>第 {selectedIndex + 1} 段</b>
        {selectedVideo === undefined ? ' · 没有原声' : ''}
      </>
    )

  // ---- 素材预览 ----
  const viewedMaterial =
    materialView === null ? undefined : materials.byJob.get(materialView.range.jobId)
  const materialLabel = (material: Material, shown: MaterialRange) => {
    const shot = shotNumberOf((shown.startMs + shown.endMs) / 2, material.url, keyframes)
    return `素材 · ${material.groupLabel} · ${material.takeLabel}${shot === undefined ? '' : ` · 镜头 ${shot}`}`
  }
  const showMaterial = (shown: MaterialRange, show: MaterialView['show']) => {
    previewRef.current?.pause()
    setRange(shown)
    setMaterialView({ range: shown, show })
  }

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
          <TabsList aria-label="素材、品牌与通用" className="wf-side-tabs">
            <TabsTrigger value="materials">素材</TabsTrigger>
            <TabsTrigger value="brand">品牌</TabsTrigger>
            <TabsTrigger value="general">通用</TabsTrigger>
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
          <TabsContent className="wf-side-body is-components" value="brand">
            <ComponentsPanel
              captionComponent={draft.captions.component}
              emptyText="暂无品牌组件"
              groups={brandGroups(catalog)}
              groupsLabel="品牌"
              onCarry={carryComponent}
              onDrop={dropComponent}
              onSelect={(id) => setSideChips((chips) => ({ ...chips, brand: id }))}
              onUse={placeFromCard}
              selected={sideChips.brand}
            />
          </TabsContent>
          <TabsContent className="wf-side-body is-components" value="general">
            <ComponentsPanel
              captionComponent={draft.captions.component}
              emptyText="暂无组件"
              groups={categoryGroups(catalog)}
              groupsLabel="分类"
              onCarry={carryComponent}
              onDrop={dropComponent}
              onSelect={(id) => setSideChips((chips) => ({ ...chips, general: id }))}
              onUse={placeFromCard}
              selected={sideChips.general}
            />
          </TabsContent>
        </TabsRoot>
        <PreviewPlayer
          controlRef={previewRef}
          height={(draft.canvas ?? DEFAULT_CANVAS).height}
          message={playBlocked}
          onPlaying={setPlaying}
          onTime={onTime}
          srcdoc={preview.kind === 'ready' ? preview.html : undefined}
          width={(draft.canvas ?? DEFAULT_CANVAS).width}
        />
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
        <div className="wf-timeline">
          <EditorToolbar
            beatBlocked={beatBlocked}
            canRedo={session.canRedo}
            canUndo={session.canUndo}
            deleteBlocked={selection === null ? '先选中要删除的片段' : undefined}
            onBeatSync={beatSync}
            onDelete={() => remove(selection)}
            onFit={() => setZoom(FIT_ZOOM)}
            onPlay={togglePlay}
            onRedo={redo}
            onSnap={() => setSnap((value) => !value)}
            onSplit={() => {
              if (apply(split) && split.ok) setSelection(null)
            }}
            onUndo={undo}
            onZoom={(direction) => setZoom(nextZoom(direction, zoom, scale.fitPps))}
            playBlocked={materialView === null ? playBlocked : undefined}
            playheadMs={playhead}
            playing={materialView === null ? playing : materialPlaying}
            snap={snap}
            splitBlocked={split.ok ? undefined : REFUSAL_TEXT[split.refusal]}
            totalMs={total}
          />
          <SoundRow
            clipBlocked={
              selectedIndex < 0 ? '先在成片轨上选中一段视频' : REFUSAL_TEXT['not-a-video']
            }
            clipText={clipText}
            clipVolume={selectedVideo?.volume}
            musicVolume={draft.music?.volume}
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
            componentFace={componentFace}
            context={context}
            draft={draft}
            music={
              song === undefined || songUrl === undefined
                ? undefined
                : { url: songUrl, title: musicTitleOf(song), peaks: peaksStateOf(songAnalysis) }
            }
            musicAction={
              <MusicAction
                conversationId={conversationId}
                musicJobId={draft.music?.jobId}
                onNotice={notice}
                onOpenMusic={() => setSideTab('materials')}
              />
            }
            onCaptionStyle={() => {
              setSideTab('general')
              setSideChips((chips) => ({ ...chips, general: 'captions' }))
            }}
            onCaptionText={editCaption}
            onClipClick={playClip}
            onSeek={seek}
            onSelect={(next) => {
              leaveMaterial()
              setSelection(next)
              if (next === null) setPopoverId(null)
            }}
            onViewportWidth={setViewportWidth}
            peaks={peaks}
            playheadMs={playhead}
            popovers={{
              openId: popoverId,
              onOpen: setPopoverId,
              render: renderPopover,
              hasFields,
            }}
            scale={scale}
            selection={selection}
            sentenceText={sentenceText}
            snap={snap}
            tracksRef={tracksRef}
            urlOf={(sourceJobId) => materials.byJob.get(sourceJobId)?.url}
          />
          <MaterialArea
            groups={materials.groups}
            keyframes={keyframes}
            onCarry={(carry) => {
              const payload =
                carry === null ? undefined : materialPayload(carry.range, carry.origin)
              if (carry === null || payload === undefined) tracksRef.current?.cancel()
              else tracksRef.current?.carry(carry.clientX, carry.clientY, payload)
            }}
            onDrop={(clientX, clientY, picked) => {
              const payload = materialPayload(picked)
              return (
                payload !== undefined &&
                (tracksRef.current?.release(clientX, clientY, payload) ?? false)
              )
            }}
            onInsert={() => insert({ timeMs: playhead })}
            onPick={(picked) => showMaterial(picked, 'play')}
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
                  message={errorMessageOf(videos.error, '读取成片失败')}
                />
              ) : videos.isPending ? (
                <p className="wf-panel-note" role="status">
                  正在读取成片…
                </p>
              ) : undefined
            }
            previewMs={materialView === null ? undefined : materialMs}
            range={range}
            used={usedSpans(draft.layer0)}
            versionOf={versionOf}
          />
        </div>
      </div>
    </>
  )
}
