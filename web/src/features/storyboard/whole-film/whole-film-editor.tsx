import {
  useCallback,
  useEffect,
  useId,
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
import { Button } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { keyframeRanges } from '../editing/keyframe-segments'
import { useAudioPeaks } from '../editing/media-analysis'
import { Frames } from '../editing/timeline'
import { isShortcutTarget } from '../editing/shortcut-target'
import { handleUndoShortcut } from '../editing/undo-shortcut'
import { useStableValue } from '../editing/use-stable-value'
import { useShotGenerations } from '../storyboard.api'
import {
  brandGroups,
  captionStyles,
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
import { moveEditOf } from './canvas-drag'
import { CanvasLayer } from './canvas-layer'
import { transformEditOf } from './canvas-transform'
import { captionTextEdit, componentTextEdit } from './canvas-text-edit'
import { CaptionControls, CaptionStatus } from './caption-controls'
import { ComponentPopover } from './component-popover'
import { ComponentsPanel, ComponentThumb, type CardCarry } from './components-panel'
import { DEFAULT_CANVAS } from './composition/build'
import { placeCaptions, type PlacedCaption, type SubtitleRecord } from './composition/captions'
import { autoBeatSync } from './editing/beat-sync'
import { setCaptionsHidden, setCaptionStyle, setCaptionsVariables } from './editing/captions'
import {
  MAX_FILM_MS,
  type ComponentVariables,
  type Layer0Clip,
  type VideoClip,
} from './editing/draft'
import {
  deleteClips,
  insertMaterial,
  moveClips,
  setClipsVolume,
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
import { EditorToolbar } from './editor-toolbar'
import { ExportControl } from './export-control'
import {
  FilmTracks,
  type Attempt,
  type CarryPayload,
  type ComponentFace,
  type DropPoint,
  type TracksHandle,
} from './film-tracks'
import { MaterialArea, type MaterialCarry } from './material-area'
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
import { useMeasuredMusicDurations, useMusicAnalysis, useMusicBeats } from './music-analysis'
import { MusicAction, MusicPanel } from './music-panel'
import { peaksStateOf } from './music-view'
import { compositionMedia, previewState } from './preview-document'
import { PreviewPlayer, type PreviewControl } from './preview-player'
import { FILM_LIMIT_TEXT, REFUSAL_TEXT } from './refusal-text'
import { clickClip, clipIdsOf, type Selection } from './selection'
import { FIT_ZOOM, nextZoom, timelineScale, type Zoom } from './timeline-scale'
import { useDraftSession } from './use-draft-session'
import { useSubtitleRecognition } from './use-subtitle-recognition'
import { useWholeFilmExport } from './use-whole-film-export'
import { useConversationMusic, useWholeFilmDraftQuery } from './whole-film.api'
import './whole-film.css'

type Props = {
  conversationId: string
  conversationTitle: string
  onClose: () => void
}

type SideTab = 'materials' | 'brand' | 'general'

/** 品牌栏、通用栏各自选中的小标题；没选过为 undefined，取第一个 */
type SideChips = Readonly<Record<'brand' | 'general', string | undefined>>

/** 能删除的选中：字幕以外的 */
type Removable = Exclude<NonNullable<Selection>, { kind: 'caption' }>

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

/** 成片编辑器：把这段对话的各条素材片剪成一条成片，草稿自动存在服务端。 */
export function WholeFilmEditor({ conversationId, conversationTitle, onClose }: Props) {
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

/** 素材里 ms 这一刻是第几个镜头；镜头表还没读到时 undefined */
const shotNumberOf = (ms: number, url: string, keyframes: KeyframeStates) => {
  const state = keyframes.get(url)
  return state?.kind === 'ready' ? shotAt(keyframeRanges(state.index), ms / 1000) : undefined
}

/** 素材选区写成「 · 镜头 2」或「 · 镜头 2–4」（按选中的头尾两个镜头）；镜头表还没读到时为空 */
const shotsLabelOf = (range: MaterialRange, url: string, keyframes: KeyframeStates) => {
  const [first] = range.shots
  const last = range.shots.at(-1)
  if (first === undefined || last === undefined) return ''
  const from = shotNumberOf((first.startMs + first.endMs) / 2, url, keyframes)
  const to = shotNumberOf((last.startMs + last.endMs) / 2, url, keyframes)
  if (from === undefined || to === undefined) return ''
  return from === to ? ` · 镜头 ${from}` : ` · 镜头 ${from}–${to}`
}

const attemptOf = (result: EditResult): Attempt =>
  result.ok ? result : { ok: false, reason: REFUSAL_TEXT[result.refusal] }

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
  const session = useDraftSession(conversationId, initial, { onNotice: notice })
  const { draft } = session
  const [materialView, setMaterialView] = useState<MaterialView | null>(null)
  const [materialMs, setMaterialMs] = useState(0)
  const [materialPlaying, setMaterialPlaying] = useState(false)
  const materialPreviewRef = useRef<MaterialPreviewControl | null>(null)
  // 拖播放头、点画面轨或做成片编辑时回到成片；播放暂停控制当前预览。
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
  const captionStatusId = useId()
  const recognition = useSubtitleRecognition({
    conversationId,
    sourceJobIds: draft.layer0.flatMap((clip) => (clip.type === 'video' ? [clip.sourceJobId] : [])),
  })
  const unmeasured = useStableValue(
    (music.data ?? []).flatMap((job) =>
      job.status === 'completed' && job.outputUrl !== null && job.durationMs === null
        ? [job.outputUrl]
        : [],
    ),
  )
  const musicDurations = useMeasuredMusicDurations(unmeasured)
  const songIndex = music.data?.findIndex((job) => job.id === draft.music?.jobId) ?? -1
  const song = music.data?.[songIndex]
  const songUrl = song?.outputUrl ?? undefined
  const songAnalysis = useMusicAnalysis(songUrl)
  const beats = useMusicBeats(songUrl)

  const context = useMemo(
    () =>
      buildEditContext({
        materials: materials.byJob.values(),
        keyframes,
        subtitles: recognition.records ?? [],
        music: music.data ?? [],
        musicDurations,
        beats:
          beats.kind === 'ready' && draft.music !== null
            ? { jobId: draft.music.jobId, beats: beats.beats }
            : undefined,
        catalog,
      }),
    [
      materials,
      keyframes,
      recognition.records,
      music.data,
      musicDurations,
      beats,
      draft.music,
      catalog,
    ],
  )

  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const previewRef = useRef<PreviewControl | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [popoverId, setPopoverId] = useState<string | null>(null)
  // 画面上正在显示的合成页，画面点选在它里面找点中了什么
  const [previewFrame, setPreviewFrame] = useState<HTMLIFrameElement | null>(null)
  const [sideTab, setSideTab] = useState<SideTab>('materials')
  const [sideChips, setSideChips] = useState<SideChips>({ brand: undefined, general: undefined })
  const [snap, setSnap] = useState(true)
  const [zoom, setZoom] = useState<Zoom>(FIT_ZOOM)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [range, setRange] = useState<MaterialRange | null>(null)
  const tracksRef = useRef<TracksHandle | null>(null)

  const total = filmDuration(draft)
  const scale = timelineScale(viewportWidth, total, zoom)
  const playhead = Math.min(playheadMs, total)
  // 停在成片末尾时仍取最后一帧所在的镜头；组件或空白段不沿用上一镜的背景。
  const frameMs = Math.min(playhead, Math.max(0, total - 1))
  const previewClip = draft.layer0.find(
    (clip) => clip.start <= frameMs && frameMs < clip.start + clip.duration,
  )
  const previewUrl =
    previewClip?.type === 'video' ? materials.byJob.get(previewClip.sourceJobId)?.url : undefined
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
  /**
   * 点画面轨上的段（extend：按着 Shift）：选中、扩选或去掉一端，播放头停在选区开头，不播放；
   * 只选了一段组件段且它有可填项时打开浮层，选了几段时不开
   */
  const selectClip = (clip: Layer0Clip, extend: boolean) => {
    const next = clickClip(draft.layer0, selection, clip.id, extend)
    setSelection(next)
    const ids = clipIdsOf(next)
    setPopoverId(
      ids.length === 1 && clip.type === 'component' && hasFields(clip.component) ? clip.id : null,
    )
    const first = draft.layer0.find((item) => ids.includes(item.id))
    if (first !== undefined) seek(first.start)
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
      { sourceJobId: picked.jobId, pieces: rangePieces(picked), at },
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

  /** 拖着素材区选中的范围 picked：落在画面轨上插到最近的切点 */
  const materialPayload = (
    picked: MaterialRange,
    origin?: MaterialCarry['origin'],
  ): CarryPayload | undefined => {
    const material = materials.byJob.get(picked.jobId)
    if (material === undefined) return undefined
    const duration = picked.endMs - picked.startMs
    const blocked =
      context.sources[picked.jobId] === undefined ? '正在读取素材时长，稍后再试' : undefined
    return {
      durationMs: duration,
      ghost:
        origin === undefined
          ? undefined
          : {
              origin,
              face: {
                title: `${takeLetterOf(material)}${shotsLabelOf(picked, material.url, keyframes)}`,
                durationMs: duration,
                media: (
                  <Frames
                    part={{
                      mediaUrl: material.url,
                      start: picked.startMs / 1000,
                      end: Math.min(picked.endMs, picked.startMs + 500) / 1000,
                    }}
                  />
                ),
              },
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

  const selectedClipIds = clipIdsOf(selection)
  // 原声推子显示选区里第一段视频的音量
  const selectedVideo = draft.layer0.find(
    (clip): clip is VideoClip => clip.type === 'video' && selectedClipIds.includes(clip.id),
  )
  const [splitPreferred] = selectedClipIds
  const split = splitClip(draft, {
    timeMs: playhead,
    ...(splitPreferred === undefined ? {} : { clipId: splitPreferred }),
  })
  const removeResult = (target: Removable): EditResult =>
    target.kind === 'clip'
      ? deleteClips(draft, { clipIds: target.ids })
      : target.kind === 'overlay'
        ? removeOverlay(draft, { overlayId: target.id })
        : removeMusic(draft)
  /** 删除选中的；字幕是识别出来的，不能删 */
  const remove = (target: Selection) => {
    if (target === null || target.kind === 'caption') return
    if (apply(removeResult(target))) {
      setSelection(null)
      setPopoverId(null)
    }
  }

  /**
   * 单键快捷键：空格播放、暂停；Delete / ⌫ 删除选中的；⌥←/→ 把选中的段整块前后挪一位；选中特效块时
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
      const [first] = selection.ids
      const from = draft.layer0.findIndex((clip) => clip.id === first)
      const to = sign < 0 ? from - 1 : from + selection.ids.length + 1
      if (apply(moveClips(draft, { clipIds: selection.ids, to })))
        tracksRef.current?.focusClip(first)
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
  // 卡点要知道每个组件段多长才能挪它的出点；组件库里没有的组件不知道
  const unknownComponent = draft.layer0.some(
    (clip) => clip.type === 'component' && context.components[clip.component] === undefined,
  )
  const beatBlocked =
    draft.music === null
      ? REFUSAL_TEXT['no-music']
      : !musicKnown || beats.kind === 'loading'
        ? '正在分析这首音乐的拍点，稍后再试'
        : beats.kind === 'unavailable'
          ? beats.reason
          : unknownComponent
            ? '画面轨上有组件库里没有的组件，无法卡点；请删掉它或换一个组件'
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
      thumbnail: item === undefined ? undefined : thumbnailOf(catalog, item),
      icon: (item === undefined ? undefined : CATEGORY_ICON[item.category]) ?? 'grid',
    }
  }
  /** 放进成片后选中新的组件段或特效块；有可填项就打开它的浮层 */
  const place = (item: CatalogItem, placing: Placing): boolean => {
    const result = placeComponent(draft, item, placing)
    if (!apply(result) || !result.ok) return false
    const placed = placedPiece(draft, result.draft)
    if (placed !== undefined) {
      setSelection(placed.kind === 'clip' ? { kind: 'clip', ids: [placed.id] } : placed)
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
   * 拖着组件卡：落在画面轨插成一段，落在特效轨放成特效块，音乐轨不收组件。
   * 手上的缩影是预览图加名字的小条，拿起时的卡片位置是它退回的地方。
   */
  const componentPayload = (item: CatalogItem, origin?: CardCarry['origin']): CarryPayload => ({
    durationMs: durationMsOf(item),
    ghost:
      origin === undefined
        ? undefined
        : {
            origin,
            face: {
              title: item.title,
              durationMs: durationMsOf(item),
              media: <ComponentThumb catalog={catalog} iconSize="xs" item={item} />,
            },
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
            selection: { kind: 'clip', ids: [id] } as const,
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
        catalog={catalog}
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
  /** 改一句字幕的字；返回写没写进草稿（没变不记编辑） */
  const editCaption = (caption: PlacedCaption, text: string): boolean => {
    const result = captionTextEdit(draft, {
      caption,
      text,
      current: sentenceText(caption),
      recognized: recognized(caption),
    })
    return result !== null && apply(result)
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
  const canvas = draft.canvas ?? DEFAULT_CANVAS
  /** 在画面上点中：等于在时间线上点中，但不打开组件浮层 */
  const selectOnCanvas = (next: Selection) => {
    setSelection(next)
    setPopoverId(null)
  }

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

  // ---- 素材预览 ----
  const viewedMaterial =
    materialView === null ? undefined : materials.byJob.get(materialView.range.jobId)
  const materialLabel = (material: Material, shown: MaterialRange) =>
    `素材 · ${material.groupLabel} · ${material.takeLabel}${shotsLabelOf(shown, material.url, keyframes)}`
  const showMaterial = (shown: MaterialRange, show: MaterialView['show']) => {
    previewRef.current?.pause()
    setRange(shown)
    setMaterialView({ range: shown, show })
  }

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
              catalog={catalog}
              emptyText="暂无品牌组件"
              groups={brandGroups(catalog)}
              groupsLabel="品牌"
              onCarry={carryComponent}
              onDrop={dropComponent}
              onSelect={(id) => setSideChips((chips) => ({ ...chips, brand: id }))}
              onUse={placeFromCard}
              origin={window.location.origin}
              selected={sideChips.brand}
            />
          </TabsContent>
          <TabsContent className="wf-side-body is-components" value="general">
            <ComponentsPanel
              catalog={catalog}
              emptyText="暂无组件"
              groups={categoryGroups(catalog)}
              groupsLabel="分类"
              onCarry={carryComponent}
              onDrop={dropComponent}
              onSelect={(id) => setSideChips((chips) => ({ ...chips, general: id }))}
              onUse={placeFromCard}
              origin={window.location.origin}
              selected={sideChips.general}
            />
          </TabsContent>
        </TabsRoot>
        <PreviewPlayer
          backdrop={previewUrl === undefined ? undefined : videoSnapshotUrl(previewUrl, 320)}
          controlRef={previewRef}
          height={canvas.height}
          message={playBlocked}
          onFrame={setPreviewFrame}
          onPlaying={setPlaying}
          onTime={setPlayheadMs}
          srcdoc={preview.kind === 'ready' ? preview.html : undefined}
          width={canvas.width}
        >
          <CanvasLayer
            canvas={canvas}
            captions={captions}
            componentTitle={(name) => componentFace(name).title}
            draft={draft}
            iframe={previewFrame}
            onCaptionText={editCaption}
            onComponentText={(change) => {
              const result = componentTextEdit(draft, change)
              return result !== null && apply(result)
            }}
            onMove={(op) => {
              const result = moveEditOf(draft, op)
              return result !== null && apply(result)
            }}
            onPause={() => previewRef.current?.pause()}
            onSelect={selectOnCanvas}
            onTransform={(target, args) => {
              const result = transformEditOf(draft, target, args)
              return result !== null && apply(result)
            }}
            playheadMs={playhead}
            playing={playing}
            selection={selection}
            sentenceText={sentenceText}
            snap={snap}
          />
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
        <div className="wf-timeline">
          <EditorToolbar
            beatBlocked={beatBlocked}
            canRedo={session.canRedo}
            canUndo={session.canUndo}
            deleteBlocked={
              selection === null || selection.kind === 'caption' ? '先选中要删除的片段' : undefined
            }
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
            clipBlocked={
              draft.layer0.some((clip) => selectedClipIds.includes(clip.id))
                ? REFUSAL_TEXT['not-a-video']
                : '先在画面轨上选中一段视频'
            }
            clipVolume={selectedVideo?.volume}
            musicVolume={draft.music?.volume}
            onClipVolume={(volume) =>
              apply(setClipsVolume(draft, { clipIds: selectedClipIds, volume }))
            }
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
            captionControls={
              <CaptionControls
                catalog={catalog}
                component={draft.captions.component}
                hidden={draft.captions.hidden === true}
                onStyle={(component) => apply(setCaptionStyle(draft, { component }))}
                onVariables={(variables) => apply(setCaptionsVariables(draft, { variables }))}
                variables={draft.captions.variables ?? {}}
                onToggleHidden={() =>
                  apply(setCaptionsHidden(draft, { hidden: !draft.captions.hidden }))
                }
                recognition={recognition}
                statusId={captionStatusId}
                styles={captionStyles(catalog)}
              />
            }
            captionStatus={
              <CaptionStatus
                hasCaptions={captions.length > 0}
                id={captionStatusId}
                recognition={recognition}
              />
            }
            captions={captions}
            clipLabel={clipLabel}
            componentFace={componentFace}
            context={context}
            draft={draft}
            music={
              song === undefined || songUrl === undefined
                ? undefined
                : {
                    url: songUrl,
                    title: `音乐 ${songIndex + 1}`,
                    peaks: peaksStateOf(songAnalysis),
                  }
            }
            musicAction={
              <MusicAction
                conversationId={conversationId}
                musicJobId={draft.music?.jobId}
                onNotice={notice}
                onOpenMusic={() => setSideTab('materials')}
              />
            }
            onCaptionText={editCaption}
            onClipClick={selectClip}
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
            onClear={() => {
              setRange(null)
              leaveMaterial()
            }}
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
                  message={errorMessageOf(videos.error, '读取素材片失败')}
                />
              ) : videos.isPending ? (
                <p className="wf-panel-note" role="status">
                  正在读取素材片…
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
