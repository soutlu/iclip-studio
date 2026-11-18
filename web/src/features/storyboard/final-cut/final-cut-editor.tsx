import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MediaBuffering } from '@/shared/ui/media-buffering'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { toast } from '@/shared/ui/toast'
import { useWorkbenchCollapsed, type ArtifactRendererProps } from '@/shared/workbench'
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
  captionSpot,
  narrationSpot,
  NEW_CAPTION_TEXT,
  RECOGNITION_REFUSAL_TEXT,
  recognitionTargets,
  recognizedCaptions,
  type Sentence,
} from './caption-edit'
import type { LayerMeasure } from './preview-protocol'
import { CanvasOverlay, type CanvasNudge } from './canvas-overlay'
import { CaptionsTab } from './captions-tab'
import { analyseBeats } from './beat-analysis'
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
import { isDubClip, type Canvas, type CaptionClip, type FilmClip } from './composition/film'
import { textHosts, type LocaleBindings } from './composition/locale-text'
import {
  voiceOfLine,
  withLineVoice,
  type LineVoice,
  type LineVoices,
  type VoiceMode,
  type VoiceSetting,
} from './composition/voices'
import {
  dubbingPlanOf,
  dubbingRefusalText,
  dubClips,
  dubsOf,
  lineRefusals,
  lineRefusalText,
  narrationDubs,
  shownIn,
  type VoiceOfCaption,
} from './dubbing'
import { isEditorKeyTarget, onCanvasLayer, useEditorEscape, useEditorRoot } from './editor-keys'
import { EditorRoot } from './editor-root'
import { EditorToolbar, type EditTool } from './editor-toolbar'
import { ExportControl } from './export-control'
import { FilmInspector } from './film-inspector'
import { FilmTimeline, type DropGhost, type TimelineHandle } from './film-timeline'
import {
  ITEM_KIND_LABEL,
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
  type LocaleCode,
  type ShownLocale,
} from './locales'
import { hostTextIn } from './host-text'
import { MaterialArea } from './material-area'
import {
  takeDurationMs,
  useKeyframeIndexes,
  useVideoAudio,
  useVideoSize,
  videoAudioQuery,
  videoSizeQuery,
  type KeyframeStates,
} from './material-media'
import { MaterialPreview, type MaterialPreviewControl, type MaterialView } from './material-preview'
import type { AttributeChanges } from './original-sound'
import {
  materialCatalog,
  rangePieces,
  shotAt,
  usedSpans,
  type Material,
  type MaterialRange,
  type MaterialTake,
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
import { aroundPlayhead } from './selection'
import {
  DETACH_LABEL,
  MERGE_LABEL,
  resyncPlan,
  soundActionFor,
  type SoundAction,
  type SoundControls,
} from './sound-pair'
import { rowMoveDirection } from './stacking'
import {
  FIT_ZOOM,
  snapSpanStartMs,
  snapTargets,
  timelineScale,
  zoomScrollLeft,
  zoomToClips,
  type Zoom,
} from './timeline-scale'
import {
  pendingTranslations,
  TRANSLATION_LIMITS,
  translateBlocked,
  translationsToWrite,
} from './translation'
import { useCaptionRecognition, type RecognitionOutcome } from './use-caption-recognition'
import { useDubbing, type DubbingDone } from './use-dubbing'
import { useFilmSession, type NewAudio } from './use-film-session'
import { useMusicBeats } from './use-music-beats'
import { useSmartMix } from './use-smart-mix'
import { useTranslation } from './use-translation'
import { useWholeFilmExport } from './use-whole-film-export'
import { withVolumePoints } from './volume-envelope'
import {
  projectFilesBase,
  useFinalCutPreviewTokens,
  useLibraryVoices,
  useProjectQuery,
  type StoredProject,
} from './final-cut.api'
import './final-cut.css'

const EMPTY_TEXT = 'final-cut 暂无内容，加入内容后可在此预览'
const PICK_FIRST_TEXT = '尚未选中镜头，无法加入 final-cut；请先在「镜头」页签中选中镜头范围'
const NO_FULLSCREEN_TEXT = '当前浏览器不支持全屏，无法进入全屏'
const ADDING_ITEM_TEXT = '上一个贴片或场景正在加入 final-cut，请稍后再试'
const ADDING_AUDIO_TEXT = '上一条音频正在加入 final-cut，请稍后再试'
const EMPTY_EXPORT_TEXT = 'final-cut 暂无内容，无法导出；请先加入内容'
const NO_FILM_CAPTION_TEXT = 'final-cut 暂无内容，无法加字幕；请先加入镜头'
const NO_FILM_LOCALE_TEXT = 'final-cut 暂无内容，无法添加语言；请先加入内容'
const READING_TAKES_TEXT = '正在读取素材片，请稍后再识别字幕'
const RECOGNIZING_TEXT = '正在识别字幕，请等待识别完成'
const READING_TAKES_DUBBING_TEXT = '正在读取素材片，请稍后再生成配音'
const NO_TAKES_DUBBING_TEXT = '找不到视频片段用的素材片记录，无法生成配音'
const ALL_UNVOICED_TEXT = '每句都选了「不配音」，无需重新生成'
const NO_FILM_NARRATION_TEXT = 'final-cut 暂无内容，无法插入旁白配音；请先加入镜头'
const DUBBING_BUSY_TEXT = '正在生成配音，请等待生成完成'
const NARRATION_UNREADABLE_TEXT = '旁白配音生成失败，请重试'
// 还没有 final-cut 时先放组件或块：和 #41 之前的编辑器一样按竖版建
const DEFAULT_CANVAS: Canvas = { width: 1080, height: 1920 }
const NO_LINKS: Links = new Map()
const NO_BINDINGS: ReadonlyMap<string, LocaleBindings> = new Map()
const NO_LINE_VOICES: LineVoices = {}

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

/** 侧栏的目录页签：镜头、贴片、场景、配乐、字幕。 */
type CatalogTab = 'shots' | ItemKind | 'audio' | 'captions'
type SideTab = CatalogTab | 'props'
const CATALOG_TABS: readonly CatalogTab[] = ['shots', ...ITEM_KINDS, 'audio', 'captions']
// 侧栏页签：当前页签是浅底块，不用共用页签的下划线
const SIDE_TAB_CLASS =
  'rounded-sm py-1 text-label text-on-surface-muted after:hidden data-[state=active]:bg-state-active data-[state=active]:font-semibold'

const watchFullscreen = (notify: () => void) => {
  document.addEventListener('fullscreenchange', notify)
  return () => document.removeEventListener('fullscreenchange', notify)
}

const fullscreenElementOf = () => document.fullscreenElement ?? null

/** 工作台「final-cut」页签里的 final-cut 编辑器，填满页签内容区。 */
export function FinalCutEditor({ conversationId }: Pick<ArtifactRendererProps, 'conversationId'>) {
  const projectQuery = useProjectQuery(conversationId)
  const catalogQuery = useComponentCatalog()
  const keysRef = useRef<((event: KeyboardEvent) => void) | null>(null)
  const failed = projectQuery.isError
    ? projectQuery
    : catalogQuery.isError
      ? catalogQuery
      : undefined
  return (
    <EditorRoot onKeyDown={(event) => keysRef.current?.(event)}>
      {projectQuery.data !== undefined && catalogQuery.data !== undefined ? (
        <EditorBody
          catalog={catalogQuery.data}
          conversationId={conversationId}
          initial={projectQuery.data}
          keysRef={keysRef}
        />
      ) : failed !== undefined ? (
        <div className="wf-state">
          <InlineAlert
            action={{ label: '重试', onClick: () => void failed.refetch() }}
            message={errorMessageOf(
              failed.error,
              failed === projectQuery ? 'final-cut 读取失败' : '贴片和场景读取失败',
            )}
          />
        </div>
      ) : (
        <p className="wf-state" role="status">
          正在读取 final-cut…
        </p>
      )}
    </EditorRoot>
  )
}

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
}: {
  conversationId: string
  initial: StoredProject | null
  catalog: ComponentCatalog
  keysRef: RefObject<((event: KeyboardEvent) => void) | null>
}) {
  const root = useEditorRoot()
  const notice = useCallback((message: string) => toast.info(message), [])
  const session = useFilmSession(conversationId, initial, catalog, { onNotice: notice })
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
  const untranslated = useMemo(
    () =>
      new Set(
        captions.filter((caption) => captionIn(locale, caption).untranslated).map((c) => c.id),
      ),
    [captions, locale],
  )
  // 贴片、场景片段上接在名字后面的文字：显示着的语言下的
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
  const versionOf = (take: MaterialTake): Material =>
    take.versions.find((item) => item.jobId === pickedVersions[take.id]) ?? take.latest
  // 「镜头」页签里显示着的版本，加上 final-cut 里视频片段用的素材（可能是没显示着的旧版本）：镜头、总长、
  // 有没有声音都先读好——加进 final-cut 时不用再等，裁剪和「原片截取」也要知道素材的总长
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

  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [buffered, setBuffered] = useState<readonly TimeSpan[]>([])
  const previewRef = useRef<PreviewControl | null>(null)
  // 画面编辑层处理方向键的函数（见 CanvasOverlay）
  const canvasNudgeRef = useRef<CanvasNudge | null>(null)
  const [range, setRange] = useState<MaterialRange | null>(null)
  const [playback, setPlayback] = useState<PlaybackSettings>({ rate: 1, muted: false, loop: false })
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
  const frameMs = Math.min(playhead, Math.max(0, total - 1))
  // 垫在预览后面的那一帧取最上面显示着的片段：文件里写在后面的在上面
  const shown = videoClips.findLast(
    (clip) => !clip.hidden && clip.start <= frameMs && frameMs < clip.start + clip.duration,
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
  // 照稿子：停在「字幕」页签时选中什么都不切走，选中的字幕在列表里标出来
  if (selectionKey !== seenSelection) {
    setSeenSelection(selectionKey)
    if (sideTab !== 'captions') setSideTab(selectionKey === '' ? catalogTab : 'props')
  }
  const selectOnly = (id: string) => setSelectedIds(new Set([id]))
  const openSideTab = (value: string) => {
    if (value === 'props') {
      setSideTab('props')
      return
    }
    const tab = CATALOG_TABS.find((each) => each === value)
    if (tab === undefined) return
    setCatalogTab(tab)
    setSideTab(tab)
  }
  const sideRef = useRef<HTMLElement | null>(null)
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
  // Esc 先退全屏（浏览器多半自己退，按键还是传到页面时才轮到这里），再取消选中，再回到选择工具；
  // 都没有时不用掉这一下
  useEditorEscape(
    fullscreen || textEditing || (!gesturing && (selected.size > 0 || tool === 'razor')),
    () => {
      if (fullscreen) exitFullscreen()
      else if (textEditing) return
      else if (selected.size > 0) clearSelection()
      else setTool('select')
    },
  )
  const selectAround = (side: 'left' | 'right') =>
    setSelectedIds(new Set(aroundPlayhead(clips, playhead, side)))
  const split = (cuts: readonly Cut[]) => {
    if (cuts.length === 0) return
    leaveMaterial()
    session.split(cuts)
  }
  // 在播放头处切开选中的片段：S、工具条的下拉都按它
  const playheadCut = playheadSplit(selectedClips, playhead, clips, links)
  const splitAtPlayhead = () => {
    if ('cuts' in playheadCut) split(playheadCut.cuts)
    else if (playheadCut.refusal === 'many') notice(SPLIT_REFUSAL_TEXT.many)
  }
  const [scrollRequest, setScrollRequest] = useState<{ left: number } | null>(null)
  // 工具条上的缩放：播放头留在屏幕上原来的地方，看不见它时把它放到中间
  const zoomTo = (next: Zoom) => {
    const left = timelineRef.current?.scrollLeft() ?? 0
    const { pps } = timelineScale(viewportWidth, total, next)
    setZoom(next)
    setScrollRequest({ left: zoomScrollLeft(playhead, left, scale.pps, pps, viewportWidth) })
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
  // 智能调音和配乐节拍读同一份声音：同一个地址只读一次
  const [decodeAudio] = useState(() => cachedDecode(decodeForCarve))
  const readBeats = useCallback(
    async (src: string) => analyseBeats(await decodeAudio(src), CARVE_SAMPLE_RATE),
    [decodeAudio],
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
   * 拖着的素材、组件、块或音频（长 `duration` 毫秒，放进 `zone` 区）会落在哪：
   * 开着吸附时先吸到别的片段的两端或播放头上，再避开同一行的片段。
   */
  const landingAt = (clientX: number, clientY: number, duration: number, zone: Zone = 'visual') => {
    const point = timelineRef.current?.locate(clientX, clientY, zone) ?? null
    if (point === null) return null
    // 拖进声音区的只有配乐：不进配音行、原声行
    const row = zone === 'audio' ? musicRowTarget(rowsOf(clips), point.row) : point.row
    const snapped = snap
      ? snapSpanStartMs(point.timeMs, duration, snapTargets(clips, playhead), scale.pps)
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
          shownIn(locale.code, film?.voiceMode ?? 'original'),
          row.zone,
          row.insertAt,
          movedId,
        )

  /** 把素材里的一段放进 final-cut：给了 `at` 放在那里，没给就接在主轨的末尾。 */
  const place = (chosen: MaterialRange, at?: { row: RowTarget; start: number }) => {
    const material = materials.byJob.get(chosen.jobId)
    if (material === undefined) return
    // 照参照的工作台：确认素材有声音才写成有声音，没有声音、读不出来都按静音写。
    // 素材区读镜头时已经一起读过，这里多半直接拿到
    const audible = queryClient.fetchQuery(videoAudioQuery(material.url)).then(
      (found) => found,
      () => false,
    )
    const pieces = rangePieces(chosen).map((piece) => {
      const shot = shotNumberOf(piece.mediaStart, material.url, keyframes)
      return {
        ...piece,
        src: material.url,
        label: `${material.takeLetter} · ${shot === undefined ? material.version : `镜头 ${shot}`}`,
      }
    })
    const add = async (canvas: Canvas) => {
      const muted = !(await audible)
      const spot = at === undefined ? undefined : trackFor(at.row)
      const added = await session.addVideos(
        canvas,
        pieces.map((piece) => ({ ...piece, muted })),
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
          notice(errorMessageOf(error, '画面尺寸读取失败，无法加入 final-cut')),
        )
  }
  const insert = () => {
    if (range === null || rangeMaterial === undefined) notice(PICK_FIRST_TEXT)
    else place(range)
  }

  // 照参照的工作台：上一个条目还没加完时不接下一个，免得两次都按加之前的样子算落点
  const addingItemRef = useRef(false)
  /** 把组件库的一个条目放进 final-cut 的 `at`；还没有 final-cut 时按默认画布建一份。 */
  const placeItem = (item: CatalogItem, at: { row: RowTarget; start: number }) => {
    if (addingItemRef.current) {
      notice(ADDING_ITEM_TEXT)
      return
    }
    addingItemRef.current = true
    const spot = trackFor(at.row)
    void session
      .addItem(
        film?.canvas ?? DEFAULT_CANVAS,
        item,
        {},
        { track: spot.track, start: at.start },
        spot.renumber,
      )
      .then((added) => {
        if (added) leaveMaterial()
      })
      .finally(() => {
        addingItemRef.current = false
      })
  }
  const addAtPlayhead = (item: CatalogItem) =>
    placeItem(item, playheadSpot(clips, item, playhead, itemDurationMs(item, clips)))

  // 和组件、块一样：上一条音频还没加完时不接下一条
  const addingAudioRef = useRef(false)
  /** 把一整条音频放进 final-cut 的 `at`；还没有 final-cut 时按默认画布建一份。 */
  const placeAudio = (audio: NewAudio, at: { row: RowTarget; start: number }) => {
    if (addingAudioRef.current) {
      notice(ADDING_AUDIO_TEXT)
      return
    }
    addingAudioRef.current = true
    const spot = trackFor(at.row)
    void session
      .addAudio(
        film?.canvas ?? DEFAULT_CANVAS,
        audio,
        { track: spot.track, start: at.start },
        spot.renumber,
      )
      .then((added) => {
        if (added) leaveMaterial()
      })
      .finally(() => {
        addingAudioRef.current = false
      })
  }
  const history = {
    canUndo: film?.canUndo ?? false,
    canRedo: film?.canRedo ?? false,
    undo: session.undo,
    redo: session.redo,
  }
  const shortcut = (event: KeyboardEvent, editor: HTMLElement) => {
    if (event.defaultPrevented || !isEditorKeyTarget(event, editor)) return
    // 全屏时菜单挂在编辑器里面，菜单里按的键归菜单；「属性」里的滑杆、下拉、取色、开关上按的键也归控件
    // 自己，照参照的工作台。时间尺上的播放位置也是滑杆，点过它以后快捷键照常用
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
    seek(Math.min(total, Math.max(0, playhead + stepMs)))
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
      layers: film.layers,
    }
  }, [film, catalog, tokens, filesRevision])
  const playBlocked = empty ? EMPTY_TEXT : undefined

  // 画面上的编辑：预览按层表认层（见 canvas-layers.ts），编辑层要量的层由它自己定
  const layerTable = useMemo(
    () =>
      (film?.layers ?? []).map(({ scope, selector, index, count }) => ({
        scope,
        selector,
        index,
        count,
      })),
    [film?.layers],
  )
  const [watchedLayers, setWatchedLayers] = useState<readonly number[]>([])
  const [layerMeasures, setLayerMeasures] = useState<ReadonlyMap<number, LayerMeasure>>(
    () => new Map(),
  )
  const [textTarget, setTextTarget] = useState<TextTarget | null>(null)

  const exporting = useWholeFilmExport(conversationId, session.settle)
  const exportBlocked = empty ? EMPTY_EXPORT_TEXT : film.captionsProblem

  // 「字幕」页签里在播放头处加一句：从播放头起 2 秒，碰到后面的字幕时缩短
  const captionAt = captionSpot(captions, playhead)
  const captionBlocked =
    film === null
      ? NO_FILM_CAPTION_TEXT
      : locale.values !== null
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

  // 「字幕」页签里的「识别字幕」：识别中照常编辑，全部有了结果后按那时的 final-cut 一次写进去
  const takeOf = (src: string) => takeOfUrl.get(src)
  const recognizable = recognitionTargets(clips, takeOf)
  /** 识别结果按 `current`（那时的片段）换算：哪些片段失败了，要加的字幕，跳过的句数，没识别出话的片段。 */
  const recognitionResult = (
    current: readonly FilmClip[],
    clipIds: readonly string[],
    outcomes: ReadonlyMap<string, RecognitionOutcome>,
  ) => {
    const wanted = new Set(clipIds)
    // 识别期间片段删掉了、有了字幕的不再写
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
    if (result.silent.length > 0) notice(`${labels(result.silent)} 没有识别出说话，未加字幕`)
    if (result.failed.length > 0)
      notice(`${labels(result.failed)} 的字幕识别失败，请点击「识别字幕」重试`)
  }
  const recognition = useCaptionRecognition(conversationId, (clipIds, outcomes) => {
    void writeRecognized(clipIds, outcomes)
  })
  const recognizeBlocked =
    recognition.recognizing > 0
      ? RECOGNIZING_TEXT
      : film === null
        ? RECOGNITION_REFUSAL_TEXT.empty
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
  // 其它语言下的「AI 配音」：按句子挑、按素材片和音色分组发起，旁白的句子各发一次（见 `dubbingPlanOf`），全部有了
  // 结果后按那时的 final-cut 一步建成配好的那几句的配音片段（换掉它们原来的）、切到 AI 配音，人声设置按发起时定的改
  const voiceLines = film?.voiceLines ?? NO_LINE_VOICES
  const languageVoice = film?.dubVoice ?? null
  const follows = (caption: string) => !Object.hasOwn(voiceLines, caption)
  /** 每句现在用的音色：自己选过的按它的，别的跟着 `voice`（默认是这种语言现在的音色）。 */
  const voicesWith =
    (voice: string | null = languageVoice): VoiceOfCaption =>
    (caption) =>
      voiceOfLine({ voice, lines: voiceLines }, caption)
  /**
   * 按 `voiceOf` 排好、`picked` 挑中的配音：素材片的请求对上各自素材片的生成记录，加上旁白的句子；`requested` 是
   * 对上之前一共有几次请求、几句旁白。
   */
  const dubbingPlan = (voiceOf: VoiceOfCaption, picked?: (caption: string) => boolean) => {
    if (film === null || target === undefined) return undefined
    const sourceMs = (src: string) => takeDurationMs(keyframes.get(src))
    const plan = dubbingPlanOf(allClips, target.values, sourceMs, voiceOf, picked)
    if ('refusal' in plan) return plan
    const takes = plan.requests.flatMap((request) => {
      const sourceJobId = takeOf(request.src)
      return sourceJobId === undefined ? [] : [{ ...request, sourceJobId }]
    })
    return {
      work: { takes, narrations: plan.narrations },
      requested: plan.requests.length + plan.narrations.length,
    }
  }
  /** 照 `plan` 发起前为什么不能发起；`requested` 为 0 时没有要配的句子，交给调用方决定。 */
  const planBlocked = (plan: ReturnType<typeof dubbingPlan>) =>
    plan === undefined || target === undefined
      ? undefined
      : videos.isPending
        ? READING_TAKES_DUBBING_TEXT
        : 'refusal' in plan
          ? dubbingRefusalText(plan.refusal, target.code)
          : plan.requested > 0 && plan.work.takes.length + plan.work.narrations.length === 0
            ? NO_TAKES_DUBBING_TEXT
            : undefined
  // 换整种语言的音色只重配跟着它的句子；「重新生成」重配要配音的每一句，各用各的音色
  const followingPlan = dubbingPlan(voicesWith(), follows)
  const everyPlan = dubbingPlan(voicesWith())
  const dubbingBlocked = planBlocked(followingPlan)
  const redoBlocked =
    planBlocked(everyPlan) ??
    (everyPlan !== undefined && 'requested' in everyPlan && everyPlan.requested === 0
      ? ALL_UNVOICED_TEXT
      : undefined)
  // 各句能不能单独配：按每句都配音时排得进请求、素材片对得上的算，有旁白的句子翻了就能配
  const unmutedPlan = dubbingPlan(() => languageVoice)
  const lineBlocked = new Map(
    film === null || target === undefined
      ? []
      : [
          ...lineRefusals(
            allClips,
            target.values,
            new Set(
              unmutedPlan === undefined || 'refusal' in unmutedPlan
                ? []
                : unmutedPlan.work.takes.flatMap(({ lines }) => lines.map((line) => line.caption)),
            ),
            (src) => takeOf(src) !== undefined,
          ),
        ].map(([caption, refusal]) => [
          caption,
          videos.isPending ? READING_TAKES_DUBBING_TEXT : lineRefusalText(refusal, target.code),
        ]),
  )
  const sourceName = (src: string) =>
    sourceNames.get(src) ?? clips.find((clip) => clip.kind === 'video' && clip.src === src)?.label
  // 原文下的旁白：合成好后在那时的播放头处（放不下往后找，见 `narrationSpot`）加一句字幕和对齐的旁白片段，一步撤销
  const writeNarration = async ({ narrations }: DubbingDone) => {
    for (const { line, outcome } of narrations) {
      if (outcome.kind === 'failed') {
        notice(`旁白配音生成失败：${outcome.message}`)
        continue
      }
      const { outputUrl, durationMs } = outcome.job
      if (outputUrl === null || durationMs === null) {
        notice(NARRATION_UNREADABLE_TEXT)
        continue
      }
      const [id] =
        (await session.addCaptions(
          (current) => [
            {
              ...narrationSpot(
                current.filter((clip) => clip.kind === 'caption'),
                playhead,
                durationMs,
              ),
              text: line.text,
              owner: null,
            },
          ],
          { src: outputUrl, label: `旁白 · ${line.text}`, voice: line.voice },
        )) ?? []
      if (id === undefined) continue
      notice('已加入旁白配音与字幕')
    }
  }
  const writeLanguageDubs = (code: LocaleCode, { update, results, narrations }: DubbingDone) => {
    const spoken = narrations.flatMap(({ line, outcome }) =>
      outcome.kind !== 'ready' || outcome.job.outputUrl === null
        ? []
        : [
            {
              line,
              audio: {
                url: outcome.job.outputUrl,
                durationMs: outcome.job.durationMs,
                trimmed: (outcome.job.dubbedLines ?? []).some((each) => each.trimmed),
              },
            },
          ],
    )
    const ready = results.flatMap(({ target: request, outcome }) => {
      const url = outcome.kind === 'ready' ? outcome.job.outputUrl : null
      return outcome.kind !== 'ready' || url === null
        ? []
        : [
            {
              request,
              track: {
                url,
                durationMs: outcome.job.durationMs,
                lines: outcome.job.dubbedLines ?? [],
              },
            },
          ]
    })
    let trimmed = 0
    const added = session.addDubs(code, update, (current) => {
      const made = ready.flatMap(({ request, track }) => dubClips(current, request, track))
      const narrated = narrationDubs(current, spoken)
      trimmed = [...made, ...narrated].filter((dub) => dub.trimmed).length
      return {
        removed: dubsOf(current, code, [
          ...ready.flatMap(({ request }) => request.lines.map((line) => line.caption)),
          ...spoken.flatMap(({ line }) => (line.caption === null ? [] : [line.caption])),
        ]),
        added: made,
        narrated,
      }
    })
    if (added > 0) notice(phraseWith(`已生成 ${added} 句`, code, '配音'))
    if (trimmed > 0) notice(`${trimmed} 句配音太长，已截短`)
    for (const { target: request, outcome } of results)
      if (outcome.kind === 'failed')
        notice(`${sourceName(request.src) ?? '素材片'} 的配音生成失败：${outcome.message}`)
    for (const { outcome } of narrations)
      if (outcome.kind === 'failed') notice(`旁白的配音生成失败：${outcome.message}`)
  }
  const writeDubs = (done: DubbingDone) => {
    if (done.locale === SOURCE_LOCALE) void writeNarration(done)
    else writeLanguageDubs(done.locale, done)
  }
  const dubbing = useDubbing(conversationId, writeDubs)
  const dubbingBusy = dubbing.generating + dubbing.narrating > 0
  // 原文下「旁白配音」展开着时也要读资料库的音色
  const [narrationOpen, setNarrationOpen] = useState(false)
  const libraryVoices = useLibraryVoices(target !== undefined || narrationOpen)
  const voicesProblem = libraryVoices.isError
    ? {
        message: errorMessageOf(libraryVoices.error, '读取音色失败'),
        onRetry: () => void libraryVoices.refetch(),
      }
    : undefined
  // 原文下的「旁白配音」：资料库里的音色都能选（原文不声明语言）；合成走配音的同一条路，和配音共用「正在生成」
  const narration =
    target !== undefined
      ? undefined
      : {
          open: narrationOpen,
          onOpen: setNarrationOpen,
          voices: libraryVoices.data?.map((each) => ({
            id: each.id,
            name: each.title,
            url: each.url,
          })),
          voicesProblem,
          generating: dubbingBusy,
          blocked:
            film === null ? NO_FILM_NARRATION_TEXT : dubbingBusy ? DUBBING_BUSY_TEXT : undefined,
          onInsert: (text: string, voice: string) =>
            void dubbing.start(
              SOURCE_LOCALE,
              { takes: [], narrations: [{ caption: null, text, voice }] },
              (setting) => setting,
            ),
        }
  // 资料库里的音色：语种对上这种语言的，或者没设语种的
  const voice =
    film === null || target === undefined
      ? undefined
      : {
          mode: film.voiceMode,
          voice: film.dubVoice,
          voices: (libraryVoices.data ?? []).flatMap((each) =>
            each.locale === null || each.locale === target.code
              ? [{ id: each.id, name: each.title, url: each.url }]
              : [],
          ),
          voicesProblem,
          // 保留原声时这种语言的配音片段藏着，也算有配音：再点配它的音色只是切回去，不重新生成
          dubbed: allClips.some((clip) => isDubClip(clip) && clip.dub.locale === target.code),
          generating: dubbing.generating,
          narrating: dubbing.narrating,
          generateBlocked: dubbingBlocked,
          redoBlocked,
          lines: voiceLines,
          lineBlocked,
          onMode: (mode: VoiceMode) => {
            leaveMaterial()
            session.setVoiceMode(target.code, mode)
          },
          onGenerate: (chosen: string | null) => {
            const plan = dubbingPlan(voicesWith(chosen), follows)
            if (planBlocked(plan) !== undefined || plan === undefined || 'refusal' in plan) return
            // 没有跟着整种语言音色的句子：不用重配，只记下音色
            if (plan.requested === 0) {
              leaveMaterial()
              session.changeVoice(target.code, (setting) => ({
                ...setting,
                mode: 'dub',
                voice: chosen,
              }))
            } else
              void dubbing.start(target.code, plan.work, (setting) => ({
                ...setting,
                voice: chosen,
              }))
          },
          onRedo: () => {
            if (redoBlocked === undefined && everyPlan !== undefined && 'work' in everyPlan)
              void dubbing.start(target.code, everyPlan.work, (setting) => setting)
          },
          onLine: (caption: string, line: LineVoice | null) => {
            if (lineBlocked.has(caption)) return
            const update = (setting: VoiceSetting) => withLineVoice(setting, caption, line)
            if (line !== null && 'dub' in line) {
              leaveMaterial()
              session.changeVoice(target.code, update, [caption])
              return
            }
            const voice = line === null ? languageVoice : line.voice
            // 实际用的音色没变、这句已有配音：只改记着的选择，不重新生成
            const dubbedLine = allClips.some(
              (clip) =>
                isDubClip(clip) && clip.dub.locale === target.code && clip.dub.caption === caption,
            )
            if (dubbedLine && voicesWith()(caption) === voice) {
              leaveMaterial()
              session.changeVoice(target.code, update)
              return
            }
            const plan = dubbingPlan(
              (each) => (each === caption ? voice : voicesWith()(each)),
              (each) => each === caption,
            )
            if (plan !== undefined && 'work' in plan)
              void dubbing.start(target.code, plan.work, update)
          },
        }

  // 贴片、场景的文字：「组件文字」和「属性」共用
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

  const viewedMaterial =
    materialView === null ? undefined : materials.byJob.get(materialView.range.jobId)
  const materialLabel = (material: Material, viewed: MaterialRange) =>
    `素材 · ${material.groupLabel} · ${material.takeLabel}${shotsLabelOf(viewed, material.url, keyframes)}`
  const showMaterial = (viewed: MaterialRange, show: MaterialView['show']) => {
    previewRef.current?.pause()
    setRange(viewed)
    setMaterialView({ range: viewed, show })
  }
  // 素材预览显示着时播放条换成素材的：时间和进度按整条原作算（还没读到时长先用选中范围的结尾），
  // 拖进度条在素材里跳
  const transportSource =
    materialView === null
      ? { playheadMs: playhead, totalMs: total, buffered, playBlocked, playing, onSeek: seek }
      : {
          playheadMs: materialMs,
          totalMs:
            takeDurationMs(
              viewedMaterial === undefined ? undefined : keyframes.get(viewedMaterial.url),
            ) ?? materialView.range.endMs,
          buffered: [],
          playBlocked: undefined,
          playing: materialPlaying,
          onSeek: (ms: number) => materialPreviewRef.current?.seek(ms),
        }

  const canvasOverlay =
    film === null || materialView !== null ? null : (
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
        revision={film.revision}
        selected={selected}
        textTarget={textTarget}
      />
    )

  if (session.opening)
    return (
      <p className="wf-state" role="status">
        正在打开 final-cut…
      </p>
    )

  /** 切到「属性」时，切走前停的目录页签留在页面上（藏起来），回来时搜索词、分类、滚动位置都还在。 */
  const catalogPanel = (tab: CatalogTab) =>
    tab === catalogTab ? { forceMount: true as const, hidden: sideTab !== tab } : {}

  return (
    <div className="wf-workspace">
      <div className="wf-stage" ref={setStage}>
        <PreviewPlayer
          backdrop={shown === undefined ? undefined : videoSnapshotUrl(shown.src, 320)}
          controlRef={previewRef}
          film={previewFilm}
          height={film?.canvas.height ?? DEFAULT_CANVAS.height}
          layers={layerTable}
          message={playBlocked}
          onBuffered={setBuffered}
          onBuffering={setBuffering}
          onMeasured={setLayerMeasures}
          onPlaying={setPlaying}
          onTextTarget={setTextTarget}
          onTime={setPlayheadMs}
          overlay={canvasOverlay}
          page={previewPage}
          playback={playback}
          watch={watchedLayers}
          width={film?.canvas.width ?? DEFAULT_CANVAS.width}
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
      <aside aria-label="镜头、贴片、场景、配乐、字幕和属性" className="wf-side" ref={sideRef}>
        <TabsRoot className="wf-side-panel" onValueChange={openSideTab} value={sideTab}>
          <TabsList
            aria-label="镜头、贴片、场景、配乐、字幕和属性页签"
            className="wf-side-tabs items-center gap-0.5"
          >
            <TabsTrigger className={SIDE_TAB_CLASS} value="shots">
              镜头
            </TabsTrigger>
            {ITEM_KINDS.map((kind) => (
              <TabsTrigger className={SIDE_TAB_CLASS} key={kind} value={kind}>
                {ITEM_KIND_LABEL[kind]}
              </TabsTrigger>
            ))}
            <TabsTrigger className={SIDE_TAB_CLASS} value="audio">
              配乐
            </TabsTrigger>
            <TabsTrigger className={SIDE_TAB_CLASS} value="captions">
              字幕·配音
            </TabsTrigger>
            <TabsTrigger className={cn(SIDE_TAB_CLASS, 'wf-side-tab-props')} value="props">
              属性
              {selected.size > 0 ? (
                <i aria-hidden="true" className="wf-side-dot" data-testid="selection-dot" />
              ) : null}
            </TabsTrigger>
          </TabsList>
          <TabsContent className="wf-side-body" value="shots" {...catalogPanel('shots')}>
            <MaterialArea
              groups={materials.groups}
              keyframes={keyframes}
              onCarry={(carry) =>
                setGhost(
                  carry === null
                    ? null
                    : landingAt(
                        carry.clientX,
                        carry.clientY,
                        carry.range.endMs - carry.range.startMs,
                      ),
                )
              }
              onDrop={(clientX, clientY, dropped) => {
                const at = landingAt(clientX, clientY, dropped.endMs - dropped.startMs)
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
              used={usedSpans(videoClips)}
              versionOf={versionOf}
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
              active={sideTab === 'audio' && !collapsed}
              clips={clips}
              conversationId={conversationId}
              onAdd={(audio) =>
                placeAudio(audio, audioPlayheadSpot(clips, playhead, audio.duration))
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
              active={sideTab === 'captions' && !collapsed}
              onNotice={notice}
              addBlocked={captionBlocked}
              captions={captions}
              texts={{
                ...itemTexts,
                hosts: textHosts(clips, catalog),
                catalog,
                onPick: (clip, jump) => {
                  if (jump) seek(clip.start)
                  selectOnly(clip.id)
                },
              }}
              locale={locale}
              narration={narration}
              onAdd={addCaption}
              onPick={(caption) => {
                seek(caption.start)
                selectOnly(caption.id)
              }}
              onRecognize={recognize}
              onRemove={(id) => {
                leaveMaterial()
                session.removeClips([id], false)
              }}
              onText={setCaptionText}
              problem={film?.captionsProblem}
              recognizeBlocked={recognizeBlocked}
              recognizing={recognition.recognizing}
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
          <TabsContent className="wf-side-body is-props" value="props">
            <FilmInspector
              audioPeaks={audioPeaks}
              clips={clips}
              catalog={catalog}
              canvas={film?.canvas ?? DEFAULT_CANVAS}
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
              onCaptionStyle={(id, changes) => {
                leaveMaterial()
                session.setCaptionStyle(id, changes)
              }}
              texts={itemTexts}
              selected={selectedClips}
              silentSource={silentSource}
              soundControls={soundControls}
              sourceMs={sourceMs}
              sourceName={(src) => sourceNames.get(src)}
              smartMix={smartMix}
            />
          </TabsContent>
        </TabsRoot>
      </aside>
      <div className="wf-timeline">
        <EditorToolbar
          actions={
            <ExportControl
              blocked={exportBlocked}
              onCancel={() => void exporting.cancel()}
              onStart={() => void exporting.start(locale.code)}
              target={{
                locale: locale.code,
                untranslated: pending === undefined ? 0 : pending.entries.length + pending.tooLong,
              }}
              view={exporting.view}
            />
          }
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
            label: soundAction.kind === 'merge' ? MERGE_LABEL : DETACH_LABEL,
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
          locales={{
            current: locale.code,
            present: film?.locales ?? [],
            addBlocked: film === null ? NO_FILM_LOCALE_TEXT : undefined,
            onSwitch: (code) => {
              leaveMaterial()
              session.setLocale(code)
            },
            onAdd: (code) => {
              leaveMaterial()
              void session.addLocale(code)
            },
          }}
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
          untranslated={untranslated}
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
          onSeek={seek}
          onSelect={setSelectedIds}
          onViewportWidth={setViewportWidth}
          playheadMs={playhead}
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
