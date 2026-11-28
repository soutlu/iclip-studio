import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { useAudition } from '@/shared/ui/audition'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MediaBuffering } from '@/shared/ui/media-buffering'
import { TabsContent, TabsRoot } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import {
  useWorkbenchCollapsed,
  WorkbenchHeaderActions,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { keyframeRanges } from '../editing/keyframe-segments'
import { useAudioPeaks } from '../editing/media-analysis'
import { handleUndoShortcut } from '../editing/undo-shortcut'
import { useStableValue } from '../editing/use-stable-value'
import { useShotGenerations } from '../storyboard.api'
import { audioPlayheadSpot } from './audio'
import { AudioTab } from './audio-tab'
import {
  CAPTION_REFUSAL_TEXT,
  captionsFocus,
  captionSpot,
  NEW_CAPTION_TEXT,
  RECOGNITION_REFUSAL_TEXT,
  recognitionTargets,
  recognizedCaptions,
  type Sentence,
} from './caption-edit'
import type { LayerMeasure } from './preview-protocol'
import { CanvasOverlay, type CanvasNudge } from './canvas-overlay'
import { CanvasSettings, FramingGuides, type Framing } from './canvas-settings'
import { canvasForVideo } from './canvas-size'
import { CaptionsTab } from './captions-tab'
import { analyseBeats } from './beat-analysis'
import { projectBeats } from './beat-file'
import { canCarve, CARVE_SAMPLE_RATE } from './carve'
import { cachedDecode, decodeForCarve } from './carve-decode'
import {
  linkedPartners,
  playheadSplit,
  SPLIT_REFUSAL_TEXT,
  type Cut,
  type Links,
  type SourceLength,
} from './clip-edit'
import { useComponentCatalog, type ComponentCatalog } from './component-catalog'
import type { CatalogItem } from './composition/catalog'
import { isDubClip, type CaptionClip, type FilmClip } from './composition/film'
import { textHosts, type LocaleBindings } from './composition/locale-text'
import { dubLooksOf } from './dub-look'
import { shownIn } from './dubbing'
import { isEditorKeyTarget, onCanvasLayer, useEditorEscape, useEditorRoot } from './editor-keys'
import { EditorRoot } from './editor-root'
import { EditorToolbar, type EditTool, type LocaleControls } from './editor-toolbar'
import { ExportControl } from './export-control'
import { exportTierOf, useChosenTier } from './export-tier'
import { FilmInspector } from './film-inspector'
import { FilmTimeline, type DropGhost, type TimelineHandle } from './film-timeline'
import {
  ITEM_KINDS,
  itemDurationMs,
  NO_FILTER,
  playheadSpot,
  type ItemFilter,
  type ItemKind,
} from './items'
import { ItemsTab } from './items-tab'
import {
  captionIn,
  phraseWith,
  SOURCE_LOCALE,
  SOURCE_NAME,
  SOURCE_SHOWN,
  translationOf,
  type Language,
  type ShownLocale,
} from './locales'
import { hostTextIn } from './host-text'
import { MaterialArea } from './material-area'
import {
  takeDurationMs,
  takeShots,
  useKeyframeIndexes,
  useVideoAudio,
  videoAudioQuery,
  videoSizeQuery,
  type KeyframeStates,
} from './material-media'
import { MaterialPreview, type MaterialPreviewControl, type MaterialView } from './material-preview'
import { snapDropToBeats } from './music-beats'
import type { AttributeChanges } from './original-sound'
import {
  materialCatalog,
  NO_PICKS,
  orderedPicks,
  picksSummary,
  shotAt,
  spanPieces,
  usedSpans,
  withTakePicks,
  type Material,
  type MaterialPicks,
  type MaterialTake,
  type MediaSpan,
  type PickedSpan,
  type TakeFilter,
  type TakePicks,
} from './materials'
import {
  landingOn,
  musicRowTarget,
  onRow,
  rowOpeningAmong,
  rowsOf,
  type RowTarget,
  type Zone,
} from './placement'
import { createPlayheadClock } from './playhead-clock'
import { previewDocument, previewRuntimeSrc } from './preview-document'
import {
  PreviewPlayer,
  type PlaybackSettings,
  type PreviewControl,
  type PreviewPageAddress,
  type TextTarget,
} from './preview-player'
import type { PreviewFilm } from './preview-sync'
import { PreviewTransport } from './preview-transport'
import { LayoutSplitter } from './layout-splitter'
import { SaveStatus } from './save-status'
import { aroundPlayhead, firstFrameMs } from './selection'
import { SideNav } from './side-nav'
import { CATALOG_TABS, usedTabs, type CatalogTab, type SideTab } from './side-tabs'
import { ThemeToggle } from './theme-toggle'
import { resyncPlan, soundActionFor, type SoundAction, type SoundControls } from './sound-pair'
import { rowMoveDirection } from './stacking'
import { FIT_ZOOM, timelineScale, zoomScrollLeft, zoomToClips, type Zoom } from './timeline-scale'
import {
  pendingTranslations,
  TRANSLATION_LIMITS,
  translateBlocked,
  translationsToWrite,
} from './translation'
import { useCaptionRecognition, type RecognitionOutcome } from './use-caption-recognition'
import { useCaptionScripts } from './use-caption-scripts'
import { SIDE_WIDTH, TIMELINE_MIN_HEIGHT, useEditorLayout } from './use-editor-layout'
import { useFilmSession, type NewAudio } from './use-film-session'
import { useMusicBeats } from './use-music-beats'
import { useSmartMix } from './use-smart-mix'
import { useTranslation } from './use-translation'
import { useVoiceControl } from './use-voice-control'
import { useWholeFilmExport } from './use-whole-film-export'
import { ownedIn } from './voice-lines'
import { VoicePicker, type VoicePickRequest, type VoicePickTarget } from './voice-picker'
import { withVolumePoints } from './volume-envelope'
import {
  createProjectFile,
  projectFilesBase,
  readProjectFile,
  useFinalCutPreviewTokens,
  useLibraryVoices,
  useProjectQuery,
  wholeFilmQueryKeys,
  writeProjectFile,
  type StoredProject,
} from './final-cut.api'
import './final-cut.css'

const EMPTY_TEXT = 'final-cut 暂无内容，加入内容后可在此预览'
const PICK_FIRST_TEXT = '尚未选中镜头，无法加入轨道；请先在「镜头」页签中选中镜头范围'
const NO_FULLSCREEN_TEXT = '当前浏览器不支持全屏，无法进入全屏'
const ADDING_ITEM_TEXT = '上一个元素或模板正在加入轨道，请稍后再试'
const ADDING_PICKS_TEXT = '选中的镜头正在加入轨道，请稍后再试'
const EMPTY_EXPORT_TEXT = 'final-cut 暂无内容，无法导出；请先加入内容'
const READING_TAKES_TEXT = '正在读取素材片，请稍后再识别字幕'
const RECOGNIZING_TEXT = '正在识别字幕，请等待识别完成'
const ELSEWHERE_TEXT = '字幕归口播起始的片段，未新增字幕'
/** 「识别」旁的识别结果提示停留多久；鼠标移开时提前收起。 */
const RECOGNIZE_NOTE_MS = 4_000
const NO_LINKS: Links = new Map()
const NO_BINDINGS: ReadonlyMap<string, LocaleBindings> = new Map()
// 播放期间 state 层的播放头节流同步间隔：兼顾依赖播放头的常规功能与性能，避免整个编辑器逐帧重绘
const PLAYING_COMMIT_MS = 100

/** 预览里的各句字幕（见 `PreviewCaptions`）：显示的字是 `locale` 值表里的字，没翻的是原文。 */
const previewCaptionsOf = (clips: readonly FilmClip[], locale: ShownLocale) =>
  new Map(
    clips.flatMap((clip) =>
      clip.kind === 'caption'
        ? [
            [
              clip.id,
              {
                variable: clip.variable,
                text: translationOf(locale.values, clip.variable) ?? clip.text,
              },
            ] as const,
          ]
        : [],
    ),
  )

const watchFullscreen = (notify: () => void) => {
  document.addEventListener('fullscreenchange', notify)
  return () => document.removeEventListener('fullscreenchange', notify)
}

const fullscreenElementOf = () => document.fullscreenElement ?? null

/**
 * 工作台「final-cut」页签编辑器（填满页签内容区）。仅当对话工作区存在主文件时呈现（新建入口见工作台顶栏「+」）；
 * 编辑期间若主文件被外部删除，会话自动卸载工程并提示已删除，由工作台据此移除页签。
 * `saveDelayMs` 控制停手后自动保存的防抖毫秒数（缺省使用 `useFilmSession` 默认值，测试中可传入短延迟加速验证）。
 */
export function FinalCutEditor({
  conversationId,
  saveDelayMs,
}: Pick<ArtifactRendererProps, 'conversationId'> & { saveDelayMs?: number }) {
  const projectQuery = useProjectQuery(conversationId)
  const catalogQuery = useComponentCatalog()
  const queryClient = useQueryClient()
  const keysRef = useRef<((event: KeyboardEvent) => void) | null>(null)
  const stored = projectQuery.data
  const failed = projectQuery.isError
    ? projectQuery
    : catalogQuery.isError
      ? catalogQuery
      : undefined
  return (
    <EditorRoot onKeyDown={(event) => keysRef.current?.(event)}>
      {stored !== undefined && stored !== null && catalogQuery.data !== undefined ? (
        <EditorBody
          catalog={catalogQuery.data}
          conversationId={conversationId}
          initial={stored}
          keysRef={keysRef}
          // 会话已检测到主文件删除，直接置空缓存避免重复请求；页签移除由工作台监听工作区文件列表统一处理
          onMissing={() =>
            queryClient.setQueryData<StoredProject | null>(
              wholeFilmQueryKeys.project(conversationId),
              null,
            )
          }
          saveDelayMs={saveDelayMs}
        />
      ) : failed !== undefined ? (
        <div className="wf-state">
          <InlineAlert
            action={{ label: '重试', onClick: () => void failed.refetch() }}
            message={errorMessageOf(
              failed.error,
              failed === projectQuery ? 'final-cut 读取失败' : '元素和模板读取失败',
            )}
          />
        </div>
      ) : (
        <p className="wf-state" role="status">
          {stored === null ? 'final-cut 已删除' : '正在读取 final-cut…'}
        </p>
      )}
    </EditorRoot>
  )
}

const shotNumberOf = (ms: number, url: string, keyframes: KeyframeStates) => {
  const state = keyframes.get(url)
  return state?.kind === 'ready' ? shotAt(keyframeRanges(state.index), ms / 1000) : undefined
}

/** 将选区单段按镜头切点拆分为待入轨片段，附带素材地址与展示名（如「A · 镜头 2」）。 */
const piecesOf = ({ material, span }: PickedSpan, keyframes: KeyframeStates) =>
  spanPieces(span, takeShots(keyframes.get(material.url))).map((piece) => {
    const shot = shotNumberOf(piece.mediaStart, material.url, keyframes)
    return {
      ...piece,
      src: material.url,
      label: `${material.takeLetter} · ${shot === undefined ? material.version : `镜头 ${shot}`}`,
    }
  })

/** 计算素材预览区间跨越的镜头编号文案（按入轨拆分规则计算）。 */
const shotsLabelOf = (span: MediaSpan, url: string, keyframes: KeyframeStates) => {
  const pieces = spanPieces(span, takeShots(keyframes.get(url)))
  const first = pieces[0]
  const last = pieces.at(-1)
  if (first === undefined || last === undefined) return ''
  const from = shotNumberOf(first.mediaStart, url, keyframes)
  const to = shotNumberOf(last.mediaStart, url, keyframes)
  if (from === undefined || to === undefined) return ''
  return from === to ? ` · 镜头 ${from}` : ` · 镜头 ${from}–${to}`
}

function EditorBody({
  conversationId,
  initial,
  catalog,
  keysRef,
  onMissing,
  saveDelayMs,
}: {
  conversationId: string
  initial: StoredProject
  catalog: ComponentCatalog
  keysRef: RefObject<((event: KeyboardEvent) => void) | null>
  onMissing: () => void
  saveDelayMs: number | undefined
}) {
  const root = useEditorRoot()
  const notice = useCallback((message: string) => toast.info(message), [])
  const session = useFilmSession(conversationId, initial, catalog, {
    debounceMs: saveDelayMs,
    onNotice: notice,
    onMissing,
  })
  const { film } = session
  // 字幕也在时间线上（单独一行）：选中、吸附、切开这些都算它们，各种片段怎么处理由各自的计算管；
  // 「字幕」页签只列字幕
  const clips = useMemo(() => film?.clips ?? [], [film])
  const captions = useMemo(
    () => clips.filter((clip): clip is CaptionClip => clip.kind === 'caption'),
    [clips],
  )
  // 显示着的语言：字幕页签、「属性」、时间线上的字幕和预览都按它
  const locale = film?.locale ?? SOURCE_SHOWN
  // 时间线上写「待输入字幕」的字幕：显示着的语言下没字的（没翻的、空着的）
  const blankCaptions = useMemo(
    () =>
      new Set(
        captions
          .filter((caption) => captionIn(locale, caption).text.trim() === '')
          .map((c) => c.id),
      ),
    [captions, locale],
  )
  // 元素、模板片段上接在名字后面的文字：显示着的语言下的
  const hostBindings = film?.bindings ?? NO_BINDINGS
  const hostTexts = useMemo(
    () =>
      new Map(
        clips.flatMap((clip) => {
          if (clip.kind !== 'host') return []
          const text = hostTextIn(locale, clip, catalog, hostBindings.get(clip.id) ?? {})
          return text === null ? [] : [[clip.id, text] as const]
        }),
      ),
    [clips, locale, catalog, hostBindings],
  )
  const empty = film === null || film.clips.length === 0
  const links = film?.links ?? NO_LINKS
  const videoClips = useMemo(() => clips.filter((clip) => clip.kind === 'video'), [clips])
  const [itemFilters, setItemFilters] = useState<Readonly<Record<ItemKind, ItemFilter>>>({
    component: NO_FILTER,
    block: NO_FILTER,
  })
  const [materialView, setMaterialView] = useState<MaterialView | null>(null)
  const [materialMs, setMaterialMs] = useState(0)
  // 供素材预览态下播放控制条订阅的时钟，与 materialMs 同步写入，更新频率跟随素材预览时间回调
  const [materialClock] = useState(createPlayheadClock)
  const followMaterial = (ms: number) => {
    setMaterialMs(ms)
    materialClock.set(ms)
  }
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
  // 「原片截取」标题里写的素材名：视频片段按地址在出片的各个版本里找
  const sourceNames = useMemo(
    () =>
      new Map(
        [...materials.byJob.values()].map((item) => [
          item.url,
          `${item.groupLabel} · ${item.takeLetter} · ${item.versionNumber}`,
        ]),
      ),
    [materials],
  )
  // 识别字幕时视频片段按地址对上素材片；同一个地址对上几条时取素材目录里排在前面的那条
  const takeOfUrl = useMemo(() => {
    const found = new Map<string, string>()
    for (const item of materials.byJob.values())
      if (!found.has(item.url)) found.set(item.url, item.jobId)
    return found
  }, [materials])
  const [pickedVersions, setPickedVersions] = useState<Readonly<Record<string, string>>>({})
  // 「镜头」页签的入轨筛选与分组折叠状态：与 itemFilters 同级托管，切走页签后返回仍可保持
  const [takeFilter, setTakeFilter] = useState<TakeFilter>('all')
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const versionOf = (take: MaterialTake): Material =>
    take.versions.find((item) => item.jobId === pickedVersions[take.id]) ?? take.latest
  // 预加载「镜头」页签当前展示版本及工程视频片段所引用的全部素材（含未展示的旧版本）的镜头索引、总时长与音轨状态：
  // 确保加入轨道时无需额外等待，同时满足裁剪与「原片截取」对素材总时长的依赖
  const videoUrls = useStableValue(
    [
      ...new Set([
        ...materials.groups.flatMap((group) => group.takes.map((take) => versionOf(take).url)),
        ...videoClips.map((clip) => clip.src),
      ]),
    ].sort(),
  )
  const keyframes = useKeyframeIndexes(videoUrls)
  const audioTracks = useVideoAudio(videoUrls)

  // 播放头单一数据源：`clock` 实时跟随每帧时刻，供时间线播放头竖线、播放条读数与进度条独立订阅；
  // `playheadMs` 供其余依赖播放头的组件使用，播放期间以 `PLAYING_COMMIT_MS` 节流同步以避免整页逐帧重绘，停播时立即对齐时钟末值
  const [clock] = useState(createPlayheadClock)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  // 预览事件按到达顺序同步处理，通过 ref 读取最新播放态，不等待 React 重渲染
  const playingRef = useRef(false)
  const committedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const followPreviewTime = (ms: number) => {
    clock.set(ms)
    const now = performance.now()
    if (playingRef.current && now - committedAtRef.current < PLAYING_COMMIT_MS) return
    committedAtRef.current = now
    setPlayheadMs(ms)
  }
  const followPlaying = (next: boolean) => {
    playingRef.current = next
    setPlaying(next)
    if (!next) setPlayheadMs(clock.get())
  }
  const [buffering, setBuffering] = useState(false)
  const [buffered, setBuffered] = useState<readonly TimeSpan[]>([])
  const previewRef = useRef<PreviewControl | null>(null)
  // 画面编辑层处理方向键的函数（见 CanvasOverlay）
  const canvasNudgeRef = useRef<CanvasNudge | null>(null)
  const [picks, setPicks] = useState<MaterialPicks>(NO_PICKS)
  const [playback, setPlayback] = useState<PlaybackSettings>({ rate: 1, muted: false, loop: false })
  // 画面参考线配置：仅作用于本次编辑会话，初始全部关闭
  const [framing, setFraming] = useState<Framing>({ grid: 'off', safeArea: false })
  const toggleMute = () => setPlayback((current) => ({ ...current, muted: !current.muted }))
  const toggleLoop = () => setPlayback((current) => ({ ...current, loop: !current.loop }))
  // 工作台折叠起来时编辑器还挂着，正在播的 final-cut 和素材不会自己停：停下，免得看不见还听得见
  const collapsed = useWorkbenchCollapsed()
  const stopPlaying = useEffectEvent(() => {
    previewRef.current?.pause()
    if (materialPlaying) materialPreviewRef.current?.toggle()
  })
  useEffect(() => {
    if (collapsed) stopPlaying()
  }, [collapsed])

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
    else stage?.requestFullscreen().catch(() => notice('打开全屏失败，请重试'))
  }

  const total = film?.durationMs ?? 0
  const playhead = Math.min(playheadMs, total)
  // 取操作瞬间播放头竖线的精确时刻：播放期间 state 层的 `playhead` 最多滞后约 0.1 秒，直接使用会导致落点偏左
  const playheadNow = () => Math.min(clock.get(), total)
  const frameMs = Math.min(playhead, Math.max(0, total - 1))
  // 垫在预览后面的那一帧取最上面显示着的片段：文件里写在后面的在上面
  const shown = videoClips.findLast(
    (clip) => !clip.hidden && clip.start <= frameMs && frameMs < clip.start + clip.duration,
  )
  const seek = (ms: number) => {
    leaveMaterial()
    clock.set(ms)
    setPlayheadMs(ms)
    previewRef.current?.seek(ms)
  }
  /** 点选时间线片段后将播放头定位至其内部：属于常规跳转，播放期间跳转后继续播放。 */
  const jumpInto = (ms: number) => {
    const resume = playing
    seek(ms)
    if (resume) previewRef.current?.play()
  }
  const togglePlay = () => {
    if (materialView !== null) {
      materialPreviewRef.current?.toggle()
      return
    }
    if (playing) previewRef.current?.pause()
    else previewRef.current?.play()
  }

  const picked = orderedPicks(materials.groups, picks)
  const queryClient = useQueryClient()

  const [viewportWidth, setViewportWidth] = useState(0)
  const [zoom, setZoom] = useState<Zoom>(FIT_ZOOM)
  const scale = timelineScale(viewportWidth, total, zoom)
  const timelineRef = useRef<TimelineHandle | null>(null)
  const [ghost, setGhost] = useState<DropGhost | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  // 选中的片段被撤销或删掉以后就不算选中了
  const selectedClips = clips.filter((clip) => selectedIds.has(clip.id))
  const selected = new Set(selectedClips.map((clip) => clip.id))
  const clearSelection = () => setSelectedIds(new Set())
  // 侧栏：选中从没有变成有、或换了别的片段时切到「属性」，选中没了回到切走之前停的目录页签。
  // 按实际还选中着的片段算，撤销、删除让选中的片段不存在了也算取消选中
  const [sideTab, setSideTab] = useState<SideTab>('shots')
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('shots')
  const selectionKey = [...selected].sort().join(' ')
  const [seenSelection, setSeenSelection] = useState(selectionKey)
  // 停留在「字幕」页签时点选片段不自动切走，对应字幕直接在列表中高亮标注
  if (selectionKey !== seenSelection) {
    setSeenSelection(selectionKey)
    if (sideTab !== 'captions') setSideTab(selectionKey === '' ? catalogTab : 'props')
  }
  const selectOnly = (id: string) => setSelectedIds(new Set([id]))
  const sideRef = useRef<HTMLElement | null>(null)
  // 右栏页签内容的可见区域：选音浮层左右与它的内容边线对齐
  const [sideScroll, setSideScroll] = useState<HTMLDivElement | null>(null)
  const timelinePanelRef = useRef<HTMLDivElement | null>(null)
  // 右栏宽度、收起态与时间线高度。选中片段时若右栏已收起则保持收起（仅点亮「属性」圆点），点击页签或双击片段时展开
  const { layout, setSideCollapsed, sideSplitter, timelineSplitter } = useEditorLayout(() => ({
    stage,
    side: sideRef.current,
    timeline: timelinePanelRef.current,
  }))
  const openSideTab = (value: string) => {
    setSideCollapsed(false)
    if (value === 'props') {
      setSideTab('props')
      return
    }
    const tab = CATALOG_TABS.find((each) => each === value)
    if (tab === undefined) return
    setCatalogTab(tab)
    setSideTab(tab)
  }
  // 切到「属性」时焦点可能还在刚藏起来的目录里（比如在卡片上按了 ]），浏览器随后把它丢到页面上，
  // 快捷键就收不到了：交还给编辑器的根节点
  useLayoutEffect(() => {
    const focused = document.activeElement
    if (focused === null || sideRef.current?.contains(focused) !== true) return
    if (focused.closest('[role="tabpanel"][hidden]') !== null) root?.focus()
  }, [root, sideTab])
  // 框选、拖片段中途的 Esc 归时间线（只取消那一次），这里先让开
  const [gesturing, setGesturing] = useState(false)
  // 「属性」里输数值的框正在输入：这时的 Esc 归那个框（放弃刚输入的），不取消选中
  const [textEditing, setTextEditing] = useState(false)
  // 时间线上点下去做什么：B 在切开和选择之间来回换，V、A 回到选择，Esc 取消选中以后也回到选择
  const [tool, setTool] = useState<EditTool>('select')
  // Esc 逐层回退：先退出全屏（通常由浏览器原生接管，仅按键透传至页面时在此兜底），
  // 其次退出素材预览、取消片段选中、清空「镜头」选区、恢复选择工具；均无待回退状态时不消费按键
  useEditorEscape(
    fullscreen ||
      textEditing ||
      (!gesturing &&
        (materialView !== null || selected.size > 0 || picks.size > 0 || tool === 'razor')),
    () => {
      if (fullscreen) exitFullscreen()
      else if (textEditing) return
      else if (materialView !== null) leaveMaterial()
      else if (selected.size > 0) clearSelection()
      else if (picks.size > 0) setPicks(NO_PICKS)
      else setTool('select')
    },
  )
  /** 在时间线上换选中：选中了片段时回到 final-cut 的预览（素材预览里看不到选中的片段，画面上也改不了它）。 */
  const selectOnTimeline = (ids: ReadonlySet<string>) => {
    if (ids.size > 0) leaveMaterial()
    setSelectedIds(ids)
  }
  const selectAround = (side: 'left' | 'right') =>
    selectOnTimeline(new Set(aroundPlayhead(clips, playheadNow(), side)))
  /** 双击时间线片段：单独选中该片段，并将右栏切换至「属性」页签（右栏收起时自动展开）。 */
  const inspectClip = (id: string) => {
    selectOnTimeline(new Set([id]))
    openSideTab('props')
  }
  const split = (cuts: readonly Cut[]) => {
    if (cuts.length === 0) return
    leaveMaterial()
    session.split(cuts)
  }
  // 在播放头处切开选中的片段：S、工具条的下拉都按它
  const playheadCut = playheadSplit(selectedClips, playhead, clips, links)
  const splitAtPlayhead = () => {
    const cut = playheadSplit(selectedClips, playheadNow(), clips, links)
    if ('cuts' in cut) split(cut.cuts)
    else if (cut.refusal === 'many') notice(SPLIT_REFUSAL_TEXT.many)
  }
  const [scrollRequest, setScrollRequest] = useState<{ left: number } | null>(null)
  // 工具条上的缩放：播放头留在屏幕上原来的地方，看不见它时把它放到中间
  const zoomTo = (next: Zoom) => {
    const left = timelineRef.current?.scrollLeft() ?? 0
    const { pps } = timelineScale(viewportWidth, total, next)
    setZoom(next)
    setScrollRequest({ left: zoomScrollLeft(playheadNow(), left, scale.pps, pps, viewportWidth) })
  }
  const zoomToSelection = () => {
    const target = zoomToClips(selectedClips, viewportWidth, scale.fitPps)
    if (target === null) return
    setZoom(target.zoom)
    setScrollRequest({ left: target.scrollLeft })
  }
  // 视频片段、音频片段素材的总长：时间线上拖着裁和「属性」里输入时间都按它收住结尾
  const audioPeaks = useAudioPeaks(
    useStableValue(
      [...new Set(clips.filter((clip) => clip.kind === 'audio').map((clip) => clip.src))].sort(),
    ),
  )
  const sourceMs: SourceLength = (clip) => {
    if (clip.kind === 'video') return takeDurationMs(keyframes.get(clip.src))
    const state = clip.kind === 'audio' ? audioPeaks.get(clip.src) : undefined
    return state?.kind === 'ready' ? Math.round(state.peaks.duration * 1000) : undefined
  }
  const [ripple, setRipple] = useState(true)
  // 删掉联动着的片段时，联动的伙伴一起删。被拒（字幕会重叠）时选中照旧，删掉了才清选中
  const removeSelected = () => {
    leaveMaterial()
    if (session.removeClips([...selected, ...linkedPartners(selected, clips)], ripple))
      clearSelection()
  }
  // 「属性」和时间线上片段的右键菜单共用这几个操作
  const hideClip = (id: string, hidden: boolean) => {
    leaveMaterial()
    session.setHidden([id], hidden)
  }
  // 改速度时联动的伙伴一起改；音量、淡入淡出、静音各管各的
  const setClipAttributes = (id: string, changes: AttributeChanges) => {
    leaveMaterial()
    const partners = 'data-playback-rate' in changes ? linkedPartners([id], clips) : []
    session.setAttributes([id, ...partners], changes)
  }
  // 「属性」页签不在时也要管：选中一段配乐就按它的规则默认打开压低
  const allClips = useMemo(() => [...clips, ...(film?.unshownDubs ?? [])], [clips, film])
  const [onlySelected] = selectedClips
  // 智能调音和算配乐节拍读同一份声音：同一个地址只读一次。工程里存着节拍文件的配乐不读声音，
  // 只有智能调音真要分析时才读
  const [decodeAudio] = useState(() => cachedDecode(decodeForCarve))
  const readBeats = useCallback(
    (src: string) =>
      projectBeats(src, async (each) => analyseBeats(await decodeAudio(each), CARVE_SAMPLE_RATE), {
        read: (path) => readProjectFile(conversationId, path),
        create: (path, content) => createProjectFile(conversationId, path, content),
        write: (path, content, version) => writeProjectFile(conversationId, path, content, version),
      }),
    [conversationId, decodeAudio],
  )
  const musicBeats = useMusicBeats(clips, readBeats, sourceMs)
  const smartMix = useSmartMix({
    clip:
      selectedClips.length === 1 && onlySelected !== undefined && canCarve(onlySelected)
        ? onlySelected
        : undefined,
    clips: allClips,
    decode: decodeAudio,
    writeCarve: session.setCarve,
    writeLeveller: session.setLeveller,
    writeRole: (id, role) => {
      leaveMaterial()
      session.setAttributes([id], { 'data-audio-group': role })
    },
    writeFx: (id, change) => {
      leaveMaterial()
      session.setFx(id, change)
    },
    writeAutomation: (id, change) => {
      leaveMaterial()
      session.setAutomation(id, change)
    },
    onNotice: notice,
  })
  const silentSource = (src: string) => audioTracks.get(src) === false
  const revealClip = (id: string) => {
    setSelectedIds(new Set([id]))
    timelineRef.current?.reveal(id)
  }
  // 分离音频、合并回视频、联动、对齐口型：「属性」、右键菜单、工具条和 ⇧⌘B 都走这里
  const soundControls: SoundControls = {
    run: (action) => {
      if (action.kind === 'none' || action.blocked !== undefined) return
      leaveMaterial()
      if (action.kind === 'merge') {
        if (session.merge(action.pair)) setSelectedIds(new Set([action.pair.video.id]))
        return
      }
      const added = session.detach(action.video.id)
      if (added !== undefined) setSelectedIds(new Set([added]))
    },
    link: (pair, linked) => {
      leaveMaterial()
      session.setLinked(pair, linked)
    },
    resync: (pair) => {
      const plan = resyncPlan(pair, clips)
      if ('refusal' in plan) {
        notice(plan.refusal)
        return
      }
      leaveMaterial()
      session.resync(pair.audio.id, plan.start)
      if (plan.displaced) notice('原声那一行的对齐位置已被占用，已移到最近的空位')
    },
    locate: revealClip,
  }
  const soundAction: SoundAction = soundActionFor(selectedClips, clips, silentSource)
  const runSoundAction = () => {
    if (soundAction.blocked !== undefined) notice(soundAction.blocked)
    else soundControls.run(soundAction)
  }
  const [snap, setSnap] = useState(true)
  /**
   * 拖着的素材、组件、块或音频（长 `duration` 毫秒，放进 `zone` 区）会落在哪：开着吸附时先吸到别的片段的两端或
   * 播放头上，都没吸上再吸配乐的节拍，然后避开同一行的片段。
   */
  const landingAt = (clientX: number, clientY: number, duration: number, zone: Zone = 'visual') => {
    const point = timelineRef.current?.locate(clientX, clientY, zone) ?? null
    if (point === null) return null
    // 拖进声音区的只有配乐：不进配音行、原声行
    const row = zone === 'audio' ? musicRowTarget(rowsOf(clips), point.row) : point.row
    const snapped = snap
      ? snapDropToBeats(point.timeMs, duration, clips, playhead, musicBeats, scale.pps)
      : { ms: point.timeMs, guideMs: null }
    // 新开的一行上没有别的片段，放在哪里都不会重叠
    const start = 'track' in row ? landingOn(clips, row, snapped.ms, duration).start : snapped.ms
    return {
      row,
      start,
      duration,
      guideMs: start === snapped.ms ? snapped.guideMs : null,
    }
  }

  /** `row` 这一行是几号；要新开一行时，连同别的片段要换成的行号。`movedId` 是要搬过去的那个片段。 */
  const trackFor = (row: RowTarget, movedId?: string) =>
    'track' in row
      ? { track: row.track, renumber: undefined }
      : rowOpeningAmong(
          allClips,
          shownIn(locale.code, film?.voiceMode ?? 'original', ownedIn(allClips)),
          row.zone,
          row.insertAt,
          movedId,
        )

  // 防止前一次入轨尚未完成时重入，避免快速连点导致同一批片段重复加入
  const addingPicksRef = useRef(false)
  /**
   * 将选中的素材区间批量首尾相接加入轨道（记为一步撤销）：传入 `at` 时从指定轨道与时刻起排，否则追加至主轨末尾；返回是否成功加入。
   */
  const place = (
    chosen: readonly PickedSpan[],
    at?: { row: RowTarget; start: number },
  ): Promise<boolean> => {
    if (chosen.length === 0) return Promise.resolve(false)
    if (addingPicksRef.current) {
      notice(ADDING_PICKS_TEXT)
      return Promise.resolve(false)
    }
    // 仅在确认素材包含音轨时标记为有声；无音轨或检测失败一律按静音写入（素材区预加载多半已命中缓存）
    const audible = new Map(
      [...new Set(chosen.map(({ material }) => material.url))].map((url) => [
        url,
        queryClient.fetchQuery(videoAudioQuery(url)).then(
          (found) => found,
          () => false,
        ),
      ]),
    )
    // 时间线尚无任何视频片段（含隐藏片段）时，自动将画布尺寸适配为首个加入片段的画幅；读不到宽高时保持不变
    const first = chosen[0]?.material.url
    const canvas =
      first === undefined || clips.some((clip) => clip.kind === 'video')
        ? undefined
        : queryClient.fetchQuery(videoSizeQuery(first)).then(
            (size) => (size === null ? undefined : canvasForVideo(size)),
            () => undefined,
          )
    const pieces = chosen.flatMap((each) => piecesOf(each, keyframes))
    const add = async () => {
      const sounding = new Set<string>()
      for (const [url, found] of audible) if (await found) sounding.add(url)
      const spot = at === undefined ? undefined : trackFor(at.row)
      const added = session.addVideos(
        pieces.map((piece) => ({ ...piece, muted: !sounding.has(piece.src) })),
        spot === undefined || at === undefined ? undefined : { track: spot.track, start: at.start },
        spot?.renumber,
        await canvas,
      )
      if (added) leaveMaterial()
      return added
    }
    addingPicksRef.current = true
    return add().finally(() => {
      addingPicksRef.current = false
    })
  }
  /** 将当前选区加入轨道（落位规则同 `place`），成功后清空选区。 */
  const placePicks = (chosen: readonly PickedSpan[], at?: { row: RowTarget; start: number }) =>
    void place(chosen, at).then((added) => {
      if (added) setPicks(NO_PICKS)
    })
  const insert = () => {
    if (picked.length === 0) notice(PICK_FIRST_TEXT)
    else placePicks(picked)
  }

  // 防止前一条元素或模板尚未落位时重入，避免并发调用均按旧时间线状态计算落点
  const addingItemRef = useRef(false)
  /** 将组件库单个条目加入轨道的 `at` 位置。 */
  const placeItem = (item: CatalogItem, at: { row: RowTarget; start: number }) => {
    if (addingItemRef.current) {
      notice(ADDING_ITEM_TEXT)
      return
    }
    addingItemRef.current = true
    const spot = trackFor(at.row)
    void session
      .addItem(item, {}, { track: spot.track, start: at.start }, spot.renumber)
      .then((added) => {
        if (added) leaveMaterial()
      })
      .finally(() => {
        addingItemRef.current = false
      })
  }
  const addAtPlayhead = (item: CatalogItem) =>
    placeItem(item, playheadSpot(clips, item, playheadNow(), itemDurationMs(item, clips)))

  /** 将单条完整音频加入轨道的 `at` 位置。 */
  const placeAudio = (audio: NewAudio, at: { row: RowTarget; start: number }) => {
    const spot = trackFor(at.row)
    if (session.addAudio(audio, { track: spot.track, start: at.start }, spot.renumber))
      leaveMaterial()
  }
  const history = {
    canUndo: film?.canUndo ?? false,
    canRedo: film?.canRedo ?? false,
    undo: session.undo,
    redo: session.redo,
  }
  const shortcut = (event: KeyboardEvent, editor: HTMLElement) => {
    if (event.defaultPrevented || !isEditorKeyTarget(event, editor)) return
    // 全屏模式下菜单挂载在编辑器容器内，菜单内按键交由菜单自身处理；「属性」内的滑杆、下拉、取色与开关同理。
    // 时间尺上的播放头滑杆不在此列，点击后仍允许全局快捷键生效
    if (
      event.target instanceof Element &&
      event.target.closest(
        '[role="menu"], [data-inspector] :is(input, [role="slider"], [role="switch"], [aria-haspopup])',
      ) !== null
    )
      return
    const { key } = event
    // 带 ⌘ / Ctrl 的只有 ⇧⌘B（分离音频或合并回视频），撤销重做在前面处理过
    if (event.metaKey || event.ctrlKey) {
      if (!event.shiftKey || event.altKey || key.toLowerCase() !== 'b') return
      event.preventDefault()
      if (!event.repeat) runSoundAction()
      return
    }
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
    // 切不开时 S 什么都不做，也照样占着这个键
    const command = event.shiftKey
      ? undefined
      : letter === 's'
        ? splitAtPlayhead
        : letter === 'b'
          ? () => setTool((current) => (current === 'razor' ? 'select' : 'razor'))
          : letter === 'v' || letter === 'a'
            ? () => setTool('select')
            : undefined
    if (command !== undefined) {
      event.preventDefault()
      if (!event.repeat) command()
      return
    }
    // 焦点在画面上时方向键挪画面上选中的片段；画面上没有选中的片段时照常挪播放头
    if (onCanvasLayer(event.target) && canvasNudgeRef.current?.(event) === true) {
      event.preventDefault()
      return
    }
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    if (event.target instanceof HTMLInputElement) return
    event.preventDefault()
    const stepMs = (key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1_000 : 100)
    seek(Math.min(total, Math.max(0, playheadNow() + stepMs)))
  }
  useEffect(() => {
    keysRef.current = (event) => {
      // 拖片段、框选进行中不接快捷键：这时撤销或删片段，松手会按改之前算好的位置写回去
      if (gesturing || root === null) return
      handleUndoShortcut(event, history, leaveMaterial)
      if (event.key === 'Enter' && event.target === root) {
        event.preventDefault()
        insert()
        return
      }
      shortcut(event, root)
    }
    return () => {
      keysRef.current = null
    }
  })

  const preview = useFinalCutPreviewTokens(conversationId)
  const previewPage: PreviewPageAddress =
    preview.page !== undefined
      ? { kind: 'ready', origin: preview.page.origin, token: preview.page.token }
      : preview.query.isError
        ? {
            kind: 'failed',
            message: errorMessageOf(preview.query.error, '预览加载失败'),
            onRetry: () => void preview.query.refetch(),
          }
        : { kind: 'pending' }
  const tokens = preview.latest
  const { filesRevision } = session
  // 预览页拿到的就是当前的主文件和字幕场景（没存的改动也在里面），别的工程文件凭最新的令牌从预览域名取，
  // 运行库从预览域名下的组件库取，和预览页同源。怎么换到预览里（打补丁还是整份重新加载）见 previewSync
  const previewFilm = useMemo((): PreviewFilm | undefined => {
    if (film === null || film.clips.length === 0 || tokens === undefined) return undefined
    const scene = film.captionsScene
    return {
      html: previewDocument(
        film.html,
        projectFilesBase(tokens.origin, tokens.token),
        film.locale,
        scene?.content ?? null,
      ),
      runtimeSrc: previewRuntimeSrc(catalog, tokens.origin),
      revision: film.revision,
      step: film.step,
      locale: film.locale.code,
      filesRevision,
      captions:
        scene === null
          ? null
          : {
              path: scene.path,
              scene: scene.content,
              captions: previewCaptionsOf(film.clips, film.locale),
            },
    }
  }, [film, catalog, tokens, filesRevision])
  const playBlocked = empty ? EMPTY_TEXT : undefined

  // 画面上的编辑：预览按层表认层（见 canvas-layers.ts），编辑层要量的层由它自己定
  const layerTable = useMemo(
    () =>
      (film?.layers ?? []).map(({ scope, selector, index, count, host }) => ({
        scope,
        selector,
        index,
        count,
        host,
      })),
    [film?.layers],
  )
  const [watchedLayers, setWatchedLayers] = useState<readonly number[]>([])
  const [layerMeasures, setLayerMeasures] = useState<ReadonlyMap<number, LayerMeasure>>(
    () => new Map(),
  )
  const [textTarget, setTextTarget] = useState<TextTarget | null>(null)

  const exporting = useWholeFilmExport(conversationId, session.settle)
  const [chosenTier, chooseTier] = useChosenTier(conversationId)
  const exportBlocked = empty ? EMPTY_EXPORT_TEXT : film.captionsProblem

  // 「字幕」页签里在播放头处加一句：从播放头起 2 秒，碰到后面的字幕时缩短
  const captionAt = captionSpot(captions, playhead)
  const captionBlocked =
    locale.values !== null
      ? phraseWith('当前语言是', locale.code, `，无法加字幕；请先切换到「${SOURCE_NAME}」`)
      : 'refusal' in captionAt
        ? CAPTION_REFUSAL_TEXT[captionAt.refusal]
        : undefined
  // 加上的那一句就是选中的这一句
  const addCaption = async () => {
    if ('refusal' in captionAt) return undefined
    leaveMaterial()
    const [id] =
      (await session.addCaptions(() => [{ ...captionAt, text: NEW_CAPTION_TEXT, owner: null }])) ??
      []
    if (id !== undefined) selectOnly(id)
    return id
  }

  // 「字幕」页签原文下的「识别」：识别期间不阻塞编辑，全部完成后按最新工程状态一次性写入。
  const takeOf = useCallback((src: string) => takeOfUrl.get(src), [takeOfUrl])
  const recognizable = recognitionTargets(clips, takeOf)
  /**
   * 按写入时刻的工程片段 `current` 汇总识别结果：失败片段、待新增字幕、重叠跳过句数、
   * 无口播片段，以及虽有口播但句子均归属其他片段的片段。
   */
  const recognitionResult = (
    current: readonly FilmClip[],
    clipIds: readonly string[],
    outcomes: ReadonlyMap<string, RecognitionOutcome>,
  ) => {
    const wanted = new Set(clipIds)
    // 跳过识别期间已删除或已存在字幕的片段。
    const found = recognitionTargets(current, takeOf)
    const targets = 'targets' in found ? found.targets.filter((t) => wanted.has(t.clipId)) : []
    const failed: string[] = []
    const sentences = new Map<string, readonly Sentence[]>()
    for (const target of targets) {
      const outcome = outcomes.get(target.sourceJobId)
      if (outcome?.kind === 'ready') sentences.set(target.clipId, outcome.sentences)
      else failed.push(target.clipId)
    }
    return { failed, ...recognizedCaptions(current, sentences) }
  }
  // 再点「识别」多半立刻有结果、鼠标还在按钮上，所以这类结果提示挂在按钮旁，到时或鼠标移开就收起
  const [recognizeNote, setRecognizeNote] = useState<string>()
  useEffect(() => {
    if (recognizeNote === undefined) return
    const timer = setTimeout(() => setRecognizeNote(undefined), RECOGNIZE_NOTE_MS)
    return () => clearTimeout(timer)
  }, [recognizeNote])
  const writeRecognized = async (
    clipIds: readonly string[],
    outcomes: ReadonlyMap<string, RecognitionOutcome>,
  ) => {
    let result = recognitionResult(clips, clipIds, outcomes)
    let added = 0
    if (result.captions.length > 0) {
      const ids = await session.addCaptions((current) => {
        result = recognitionResult(current, clipIds, outcomes)
        return result.captions
      })
      added = ids?.length ?? 0
    }
    const labels = (ids: readonly string[]) =>
      ids.map((id) => clips.find((clip) => clip.id === id)?.label ?? id).join('、')
    if (added > 0) notice(`已加入 ${added} 句字幕`)
    if (result.skipped > 0) notice(`${result.skipped} 句与已有字幕重叠，已跳过`)
    if (result.silent.length > 0) notice(`${labels(result.silent)} 未识别到口播内容，未新增字幕`)
    if (added === 0 && result.elsewhere.length > 0) setRecognizeNote(ELSEWHERE_TEXT)
    if (result.failed.length > 0)
      notice(`${labels(result.failed)} 的字幕识别失败，请点击「识别」重试`)
  }
  const recognition = useCaptionRecognition(conversationId, (clipIds, outcomes) => {
    void writeRecognized(clipIds, outcomes)
  })
  const captionScripts = useCaptionScripts({
    conversationId,
    enabled:
      sideTab === 'captions' &&
      !collapsed &&
      !layout.sideCollapsed &&
      locale.code === SOURCE_LOCALE,
    clips,
    takeOf,
    takes: videos.data,
  })
  const recognizeBlocked =
    recognition.recognizing > 0
      ? RECOGNIZING_TEXT
      : videos.isPending
        ? READING_TAKES_TEXT
        : 'refusal' in recognizable
          ? RECOGNITION_REFUSAL_TEXT[recognizable.refusal]
          : undefined
  const recognize = () => {
    if (recognizeBlocked === undefined && 'targets' in recognizable)
      void recognition.start(recognizable.targets)
  }
  // 「字幕」页签和「属性」里改字幕的字：改的是文字框所在的那种语言
  const setCaptionText = (id: string, text: string, code: Language) => {
    leaveMaterial()
    session.setCaptionText(id, text, code)
  }
  // 其它语言下的「翻译」：点的那一刻还没翻的一起发，全部翻好后按写入那一刻的样子一步写进那种语言的值表
  const translation = useTranslation(conversationId)
  const target = locale.values === null ? undefined : locale
  const pending =
    film === null || target === undefined
      ? undefined
      : pendingTranslations(
          { clips: film.clips, bindings: film.bindings, values: target.values },
          catalog,
        )
  const translateBlockedText =
    pending === undefined || target === undefined
      ? undefined
      : translateBlocked(pending, target.code, translation.translating)
  const translate = async () => {
    if (pending === undefined || target === undefined || translateBlockedText !== undefined) return
    const { code } = target
    const { entries, tooLong } = pending
    const outcome = await translation.start(code, entries)
    if (outcome.kind === 'failed') notice(outcome.message)
    if (outcome.kind !== 'done') return
    const written = session.fillLocale(code, (now) =>
      translationsToWrite(entries, outcome.translations, pendingTranslations(now, catalog).entries),
    )
    if (written > 0) notice(`已翻译 ${written} 条`)
    if (written < entries.length)
      notice(`${entries.length - written} 条在翻译期间已修改或删除，未写入译文`)
    if (tooLong > 0) notice(`${tooLong} 条超过 ${TRANSLATION_LIMITS.text} 字，未翻译；请手动填写`)
  }
  // 配音（当前显示的语言，原文也有）：选音色、改模式只记下，合成由用户点（见 `useVoiceControl`）
  const voice = useVoiceControl({
    conversationId,
    film:
      film === null ? null : { clips: allClips, voiceModes: film.voiceModes, locale: film.locale },
    sourceMs: (src) => takeDurationMs(keyframes.get(src)),
    takeOf,
    takesPending: videos.isPending,
    sourceName: (src) =>
      sourceNames.get(src) ??
      clips.find((clip) => clip.kind === 'video' && clip.src === src)?.label,
    session,
    notice,
    beforeEdit: leaveMaterial,
  })
  // 右栏收起时页签内容隐藏，与工作台折叠一致视为不可见，同步暂停页签内的试听与预览播放
  const sideVisible = !collapsed && !layout.sideCollapsed
  // 右栏共用的试听：字幕页签的单句试听和选音浮层的样音同一时间只放一条；右栏看不见、离开字幕页签且浮层收着时停下
  const [voicePick, setVoicePick] = useState<
    (VoicePickRequest & { locale: Language; tab: SideTab }) | null
  >(null)
  // 换了语言、换了页签、右栏看不见时浮层收起
  const shownPick =
    voicePick !== null &&
    voicePick.locale === locale.code &&
    voicePick.tab === sideTab &&
    sideVisible &&
    voice !== undefined
      ? voicePick
      : null
  if (voicePick !== null && shownPick === null) setVoicePick(null)
  const sideAudition = useAudition({
    active: sideVisible && (sideTab === 'captions' || shownPick !== null),
    onError: () => notice('试听失败，请重试'),
  })
  /**
   * 打开选音浮层（见 `VoicePicker`）：给这种语言的默认音色（`{ target: 'language' }`）或某一句
   * （`{ target: 'line', caption: 字幕编号 }`）选，贴着 `anchor` 弹在右栏内容区里。右栏任何页签都能唤起。
   */
  const openVoicePicker = (pick: VoicePickTarget, anchor: HTMLElement) => {
    sideAudition.stop()
    setVoicePick({ pick, anchor, locale: locale.code, tab: sideTab })
  }
  const closeVoicePicker = () => {
    sideAudition.stop()
    setVoicePick(null)
  }
  // 当前语言下各句的配音片段：字幕页签的单句试听放它
  const shownDubs = new Map(
    allClips.flatMap((clip) =>
      isDubClip(clip) && clip.dub.locale === locale.code ? [[clip.dub.caption, clip] as const] : [],
    ),
  )
  // 配音时（默认音色胶囊）、有句子自己选过音色时、浮层开着时、时间线上有用资料库音色配的配音片段时（顶行写音色名和
  // 小封面）要读资料库的音色
  const libraryVoices = useLibraryVoices(
    voice?.mode === 'dub' ||
      [...(voice?.lines.values() ?? [])].some((line) => line.own !== undefined) ||
      shownPick !== null ||
      clips.some((clip) => isDubClip(clip) && clip.dub.voice !== null),
  )
  const dubLooks = dubLooksOf(clips, voice, libraryVoices.data)
  // 时间线上还没有配音行时，在配音行的位置写一句去哪里配
  const dubHint =
    voice === undefined || captions.length === 0 || clips.some(isDubClip)
      ? null
      : voice.mode === 'original'
        ? '当前语言保留原声；在「字幕」页签切到「配音」可生成配音'
        : '当前语言还没有配音；在「字幕」页签点击「生成配音」'
  const voicesProblem = libraryVoices.isError
    ? {
        message: errorMessageOf(libraryVoices.error, '读取音色失败'),
        onRetry: () => void libraryVoices.refetch(),
      }
    : undefined
  // 导出提醒：当前语言里还是旧配音（过期）的、要配还没配的句数
  const dubGaps = { stale: 0, missing: 0 }
  for (const line of voice?.lines.values() ?? []) {
    if (line.status === 'stale') dubGaps.stale += 1
    if (line.status === 'missing') dubGaps.missing += 1
  }
  // 导出提醒里的「去重配」：切到「字幕」页签的「字幕」视图
  const [showCaptions, setShowCaptions] = useState(0)

  // 元素、模板片段的文字：「画面文字」和「属性」共用
  const itemTexts = {
    bindings: film?.bindings ?? NO_BINDINGS,
    multilingual: (film?.locales.length ?? 0) > 0,
    onText: (id: string, field: string, text: string, code: Language) => {
      leaveMaterial()
      session.setItemText(id, field, text, code)
    },
    onFollow: (id: string, field: string, follow: boolean) => {
      leaveMaterial()
      session.setFollowsLocale(id, field, follow)
    },
  }
  const hostsWithText = textHosts(clips, catalog)
  // 工具条与「字幕」页签顶部共用的语言切换与添加控制
  const localeControls: LocaleControls = {
    current: locale.code,
    present: film?.locales ?? [],
    onSwitch: (code) => {
      leaveMaterial()
      session.setLocale(code)
    },
    onAdd: (code) => {
      leaveMaterial()
      void session.addLocale(code)
    },
  }

  const viewedMaterial = materialView === null ? undefined : materials.byJob.get(materialView.jobId)
  const materialLabel = (material: Material, viewed: MediaSpan) =>
    `素材 · ${material.groupLabel} · ${material.takeLabel}${shotsLabelOf(viewed, material.url, keyframes)}`
  /** 更新「镜头」页签单条原作选区：传入 `view` 时切入素材预览，移除当前预览原作的选区时退回 final-cut 预览。 */
  const changePicks = (takeId: string, next: TakePicks, view: MaterialView | null) => {
    setPicks((current) => withTakePicks(current, takeId, next))
    if (view !== null) {
      previewRef.current?.pause()
      setMaterialView(view)
    } else if (materialView?.jobId === next.jobId) leaveMaterial()
  }
  // 素材预览显示着时播放条换成素材的：时间和进度按整条原作算（还没读到时长先用选中范围的结尾），
  // 拖进度条在素材里跳
  const transportSource =
    materialView === null
      ? { clock, totalMs: total, buffered, playBlocked, playing, onSeek: seek }
      : {
          clock: materialClock,
          totalMs:
            takeDurationMs(
              viewedMaterial === undefined ? undefined : keyframes.get(viewedMaterial.url),
            ) ?? materialView.span.endMs,
          buffered: [],
          playBlocked: undefined,
          playing: materialPlaying,
          onSeek: (ms: number) => materialPreviewRef.current?.seek(ms),
        }

  const canvasOverlay =
    film === null || materialView !== null ? null : (
      <>
        <FramingGuides canvas={film.canvas} framing={framing} />
        <CanvasOverlay
          bindings={film.bindings}
          canvas={film.canvas}
          catalog={catalog}
          clips={clips}
          contentOf={session.contentOf}
          controlRef={previewRef}
          frameMs={frameMs}
          layers={film.layers}
          locale={locale}
          measures={layerMeasures}
          nudgeRef={canvasNudgeRef}
          onCaptionText={setCaptionText}
          onEdit={(edits) => {
            leaveMaterial()
            session.editLayers(edits)
          }}
          onGesture={setGesturing}
          onNotice={notice}
          onSelect={setSelectedIds}
          onText={itemTexts.onText}
          onTextClose={() => setTextTarget(null)}
          onWatch={setWatchedLayers}
          playing={playing}
          revision={film.revision}
          selected={selected}
          textTarget={textTarget}
        />
      </>
    )

  if (film === null)
    return (
      <p className="wf-state" role="status">
        正在打开 final-cut…
      </p>
    )

  const exportTier = exportTierOf(film.canvas, chosenTier)

  /**
   * 切至「属性」或收起右栏时，保留切离前所在目录页签的挂载状态（仅隐藏展示），返回时保留搜索词、筛选条件与滚动位置；
   * 右栏收起时「属性」页签同样仅隐藏而不卸载。
   */
  const catalogPanel = (tab: CatalogTab) =>
    tab === catalogTab
      ? { forceMount: true as const, hidden: sideTab !== tab || layout.sideCollapsed }
      : {}

  return (
    <div
      className={cn(
        'wf-workspace',
        layout.sideCollapsed && 'is-side-collapsed',
        layout.timelineHeight !== null && 'is-timeline-sized',
      )}
      style={
        {
          '--wf-side-width': `${layout.sideWidth}px`,
          '--wf-timeline-height':
            layout.timelineHeight === null ? undefined : `${layout.timelineHeight}px`,
        } as CSSProperties
      }
    >
      <WorkbenchHeaderActions>
        <div className="wf-header-actions">
          <SaveStatus save={session.save} />
          <ThemeToggle />
          <ExportControl
            blocked={exportBlocked}
            onCancel={() => void exporting.cancel()}
            onStart={() => void exporting.start(locale.code, exportTier.resolution)}
            onFixDubs={() => {
              openSideTab('captions')
              setShowCaptions((count) => count + 1)
            }}
            target={{
              locale: locale.code,
              untranslated: pending === undefined ? 0 : pending.entries.length + pending.tooLong,
              resolution: exportTier.resolution,
              dubs: dubGaps,
            }}
            view={exporting.view}
          />
        </div>
      </WorkbenchHeaderActions>
      <div className="wf-stage" ref={setStage}>
        <PreviewPlayer
          backdrop={shown === undefined ? undefined : videoSnapshotUrl(shown.src, 320)}
          controlRef={previewRef}
          film={previewFilm}
          height={film.canvas.height}
          layers={layerTable}
          message={playBlocked}
          onBuffered={setBuffered}
          onBuffering={setBuffering}
          onMeasured={setLayerMeasures}
          onPlaying={followPlaying}
          onTextTarget={setTextTarget}
          onTime={followPreviewTime}
          overlay={canvasOverlay}
          page={previewPage}
          playback={playback}
          watch={watchedLayers}
          width={film.canvas.width}
        >
          {buffering ? <MediaBuffering /> : null}
        </PreviewPlayer>
        {materialView === null ? (
          <CanvasSettings
            background={film.background}
            canvas={film.canvas}
            framing={framing}
            layer={fullscreen ? stage : root}
            onBackground={session.setBackground}
            onCanvas={session.resize}
            onFraming={setFraming}
            onTier={chooseTier}
            tier={exportTier.tier}
          />
        ) : null}
        {viewedMaterial === undefined || materialView === null ? null : (
          <MaterialPreview
            controlRef={materialPreviewRef}
            label={materialLabel(viewedMaterial, materialView.span)}
            muted={playback.muted}
            layer={fullscreen ? stage : null}
            onLeave={leaveMaterial}
            onNotice={notice}
            onPlaying={setMaterialPlaying}
            onTime={followMaterial}
            rate={playback.rate}
            url={viewedMaterial.url}
            view={materialView}
          />
        )}
        <PreviewTransport
          {...transportSource}
          fullscreen={fullscreen}
          fullscreenBlocked={fullscreenBlocked}
          layer={fullscreen ? stage : null}
          onFullscreen={toggleFullscreen}
          onLoop={toggleLoop}
          onMute={toggleMute}
          onPlay={togglePlay}
          onRate={(rate) => setPlayback((current) => ({ ...current, rate }))}
          playback={playback}
        />
      </div>
      <LayoutSplitter
        className="wf-side-splitter"
        label="调整右栏宽度"
        max={SIDE_WIDTH.max}
        min={SIDE_WIDTH.min}
        orientation="vertical"
        panelRef={sideRef}
        sized={!layout.sideCollapsed}
        {...sideSplitter}
      />
      <aside
        aria-label="镜头、元素、模板、配乐、字幕和属性"
        className={cn('wf-panel wf-side', layout.sideCollapsed && 'is-collapsed')}
        ref={sideRef}
      >
        <TabsRoot
          className="wf-side-panel"
          onValueChange={openSideTab}
          orientation={layout.sideCollapsed ? 'vertical' : 'horizontal'}
          value={sideTab}
        >
          <SideNav
            collapsed={layout.sideCollapsed}
            onCollapsedChange={setSideCollapsed}
            used={usedTabs(film.clips, catalog)}
          />
          <div className="wf-side-scroll" ref={setSideScroll}>
            <TabsContent className="wf-side-body is-shots" value="shots" {...catalogPanel('shots')}>
              <MaterialArea
                closedGroups={closedGroups}
                filter={takeFilter}
                groups={materials.groups}
                keyframes={keyframes}
                onCarry={(point, carried) =>
                  setGhost(
                    point === null
                      ? null
                      : landingAt(point.clientX, point.clientY, picksSummary(carried).durationMs),
                  )
                }
                onClear={() => {
                  setPicks(NO_PICKS)
                  leaveMaterial()
                }}
                onDrop={(point, dropped) => {
                  const at = landingAt(
                    point.clientX,
                    point.clientY,
                    picksSummary(dropped).durationMs,
                  )
                  setGhost(null)
                  if (at !== null)
                    placePicks(orderedPicks(materials.groups, dropped), {
                      row: at.row,
                      start: at.start,
                    })
                }}
                onFilter={setTakeFilter}
                onInsert={insert}
                onInsertWhole={(whole) => void place([whole])}
                onPicks={changePicks}
                onToggleGroup={(groupId) =>
                  setClosedGroups((current) => {
                    const next = new Set(current)
                    if (!next.delete(groupId)) next.add(groupId)
                    return next
                  })
                }
                onVersion={(takeId, jobId) => {
                  setPickedVersions((current) => ({ ...current, [takeId]: jobId }))
                  const had = picks.get(takeId)
                  if (had === undefined) return
                  changePicks(takeId, { jobId: had.jobId, spans: [] }, null)
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
                picks={picks}
                playingMs={materialPlaying ? materialMs : undefined}
                used={usedSpans(videoClips)}
                versionOf={versionOf}
                view={materialView}
              />
            </TabsContent>
            {ITEM_KINDS.map((kind) => (
              <TabsContent
                className="wf-side-body is-items"
                key={kind}
                value={kind}
                {...catalogPanel(kind)}
              >
                <ItemsTab
                  catalog={catalog}
                  filter={itemFilters[kind]}
                  kind={kind}
                  onAdd={addAtPlayhead}
                  onCarry={(item, point) =>
                    setGhost(
                      point === null
                        ? null
                        : landingAt(point.clientX, point.clientY, itemDurationMs(item, clips)),
                    )
                  }
                  onDrop={(item, point) => {
                    const at = landingAt(point.clientX, point.clientY, itemDurationMs(item, clips))
                    setGhost(null)
                    if (at !== null) placeItem(item, { row: at.row, start: at.start })
                  }}
                  onFilterChange={(filter) =>
                    setItemFilters((current) => ({ ...current, [kind]: filter }))
                  }
                  origin={window.location.origin}
                />
              </TabsContent>
            ))}
            <TabsContent className="wf-side-body is-audio" value="audio" {...catalogPanel('audio')}>
              <AudioTab
                active={sideTab === 'audio' && sideVisible}
                clips={clips}
                conversationId={conversationId}
                onAdd={(audio) =>
                  placeAudio(audio, audioPlayheadSpot(clips, playheadNow(), audio.duration))
                }
                onCarry={(audio, point) =>
                  setGhost(
                    point === null
                      ? null
                      : landingAt(point.clientX, point.clientY, audio.duration, 'audio'),
                  )
                }
                onDrop={(audio, point) => {
                  const at = landingAt(point.clientX, point.clientY, audio.duration, 'audio')
                  setGhost(null)
                  if (at !== null) placeAudio(audio, { row: at.row, start: at.start })
                }}
                onNotice={notice}
                onReveal={revealClip}
              />
            </TabsContent>
            <TabsContent
              className="wf-side-body is-captions"
              value="captions"
              {...catalogPanel('captions')}
            >
              <CaptionsTab
                addBlocked={captionBlocked}
                audition={sideAudition}
                dubs={shownDubs}
                onPickVoice={openVoicePicker}
                onSelect={(caption) => selectOnly(caption.id)}
                picking={shownPick?.pick ?? null}
                showCaptions={showCaptions}
                captions={captions}
                texts={{
                  ...itemTexts,
                  hosts: hostsWithText,
                  catalog,
                  onPick: (clip, jump) => {
                    if (jump) seek(firstFrameMs(clip.start))
                    selectOnly(clip.id)
                  },
                }}
                locale={locale}
                locales={localeControls}
                focus={captionsFocus(selectedClips, new Set(hostsWithText.map((host) => host.id)))}
                library={{ voices: libraryVoices.data, problem: voicesProblem }}
                onAdd={addCaption}
                onPick={(caption) => {
                  seek(firstFrameMs(caption.start))
                  selectOnly(caption.id)
                }}
                onRecognize={recognize}
                onRemove={(id) => {
                  leaveMaterial()
                  session.removeClips([id], false)
                }}
                onText={setCaptionText}
                problem={film.captionsProblem}
                recognizeBlocked={recognizeBlocked}
                recognizeNote={recognizeNote}
                onRecognizeNoteClose={() => setRecognizeNote(undefined)}
                recognizing={recognition.recognizing}
                scripts={captionScripts}
                selected={selected}
                voice={voice}
                translate={
                  pending === undefined
                    ? undefined
                    : {
                        blocked: translateBlockedText,
                        translating: translation.translating,
                        onTranslate: () => void translate(),
                      }
                }
              />
            </TabsContent>
            <TabsContent
              className="wf-side-body is-props"
              hidden={sideTab !== 'props' || layout.sideCollapsed}
              value="props"
            >
              <FilmInspector
                audioPeaks={audioPeaks}
                clips={clips}
                catalog={catalog}
                canvas={film.canvas}
                keyframes={keyframes}
                onGesture={setGesturing}
                onHide={hideClip}
                onRemove={removeSelected}
                onRetime={(timings) => {
                  leaveMaterial()
                  session.retime(timings)
                }}
                onTextEditing={setTextEditing}
                onValues={(id, values) => {
                  leaveMaterial()
                  session.setValues(id, values)
                }}
                onAttributes={setClipAttributes}
                locale={locale}
                onCaptionText={setCaptionText}
                captionStyle={film.captionStyle}
                onCaptionStyle={(id, changes) => {
                  leaveMaterial()
                  session.setCaptionStyle(id, changes)
                }}
                onCaptionTrackStyle={(changes) => {
                  leaveMaterial()
                  session.setCaptionTrackStyle(changes)
                }}
                onCaptionOwnStyle={(id, own) => {
                  leaveMaterial()
                  session.setCaptionOwnStyle(id, own)
                }}
                texts={itemTexts}
                selected={selectedClips}
                silentSource={silentSource}
                soundControls={soundControls}
                sourceMs={sourceMs}
                sourceName={(src) => sourceNames.get(src)}
                smartMix={smartMix}
                onOpenCaptions={() => openSideTab('captions')}
                voice={voice}
                voices={libraryVoices.data}
              />
            </TabsContent>
          </div>
        </TabsRoot>
      </aside>
      {voice === undefined ? null : (
        <VoicePicker
          audition={sideAudition}
          container={root}
          library={{ voices: libraryVoices.data, problem: voicesProblem }}
          onClose={closeVoicePicker}
          panel={sideScroll}
          request={shownPick}
          voice={voice}
        />
      )}
      <LayoutSplitter
        className="wf-timeline-splitter"
        label="调整时间线高度"
        min={TIMELINE_MIN_HEIGHT}
        orientation="horizontal"
        panelRef={timelinePanelRef}
        sized={layout.timelineHeight !== null}
        {...timelineSplitter}
      />
      <div className="wf-panel wf-timeline" ref={timelinePanelRef}>
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
          onRemove={removeSelected}
          sound={{
            kind: soundAction.kind === 'merge' ? 'merge' : 'detach',
            blocked: soundAction.blocked,
            onClick: () => soundControls.run(soundAction),
          }}
          onSelectAround={selectAround}
          onSplit={splitAtPlayhead}
          onTool={setTool}
          splitBlocked={
            'refusal' in playheadCut ? SPLIT_REFUSAL_TEXT[playheadCut.refusal] : undefined
          }
          tool={tool}
          locales={localeControls}
          onZoomToSelection={zoomToSelection}
          onRipple={() => setRipple((on) => !on)}
          onSnap={() => setSnap((on) => !on)}
          onZoom={zoomTo}
          ripple={ripple}
          snap={snap}
          zoom={zoom}
        />
        <FilmTimeline
          clips={clips}
          blankCaptions={blankCaptions}
          dubLooks={dubLooks}
          dubHint={dubHint}
          dubbing={film?.voiceMode === 'dub'}
          hostTexts={hostTexts}
          links={links}
          onSplit={split}
          tool={tool}
          buffered={buffered}
          catalog={catalog}
          ghost={ghost}
          gesturing={gesturing}
          handleRef={timelineRef}
          onAttributes={setClipAttributes}
          onHideClip={hideClip}
          onRemove={removeSelected}
          silentSource={silentSource}
          soundControls={soundControls}
          onHide={(row, hidden) => {
            leaveMaterial()
            session.setHidden(
              clips.filter((clip) => onRow(clip, row)).map((clip) => clip.id),
              hidden,
            )
          }}
          onRetime={(timings) => {
            leaveMaterial()
            session.retime(timings)
          }}
          onGesture={setGesturing}
          onInspect={inspectClip}
          onJump={jumpInto}
          onSeek={seek}
          onSelect={selectOnTimeline}
          onViewportWidth={setViewportWidth}
          playheadMs={playhead}
          clock={clock}
          scale={scale}
          onMove={(id, row, start, starts) => {
            const { track, renumber } = trackFor(row, id)
            leaveMaterial()
            session.moveClip(
              id,
              { track, start },
              rowMoveDirection(clips, id, row),
              renumber,
              starts,
            )
          }}
          onRestart={(starts) => {
            leaveMaterial()
            session.restart(starts)
          }}
          onEnvelope={(id, points) => {
            leaveMaterial()
            session.setAutomation(id, (automation) => withVolumePoints(automation, points))
          }}
          scrollRequest={scrollRequest}
          selected={selected}
          snap={snap}
          beats={musicBeats}
          sourceMs={sourceMs}
          totalMs={total}
        />
        {session.save.kind === 'failed' ? (
          <InlineAlert
            action={{ label: '重新保存', onClick: session.flush }}
            message={session.save.message}
          />
        ) : null}
      </div>
    </div>
  )
}
