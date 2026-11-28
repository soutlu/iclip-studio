import { useCallback, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import {
  useWorkbenchCollapsed,
  WorkbenchHeaderActions,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import type { CanvasNudge } from './canvas-overlay'
import type { Links } from './clip-edit'
import { useComponentCatalog, type ComponentCatalog } from './component-catalog'
import { isDubClip, type CaptionClip } from './composition/film'
import type { LocaleBindings } from './composition/locale-text'
import { dubLooksOf } from './dub-look'
import { useEditorEscape, useEditorRoot } from './editor-keys'
import { EditorRoot } from './editor-root'
import { EditorSide } from './editor-side'
import { EditorStage } from './editor-stage'
import { EditorTimelinePanel } from './editor-timeline-panel'
import type { EditTool, LocaleControls } from './editor-toolbar'
import { ExportControl } from './export-control'
import { exportTierOf, useChosenTier } from './export-tier'
import { NO_FILTER, type ItemFilter, type ItemKind } from './items'
import { SOURCE_SHOWN, type Language } from './locales'
import { takeDurationMs } from './material-media'
import { NO_PICKS } from './materials'
import type { PreviewControl } from './preview-player'
import { LayoutSplitter } from './layout-splitter'
import { SaveStatus } from './save-status'
import { ThemeToggle } from './theme-toggle'
import { useCaptionTools } from './use-caption-tools'
import { useClipCommands } from './use-clip-commands'
import { useEditorShortcuts } from './use-editor-shortcuts'
import { SIDE_WIDTH, TIMELINE_MIN_HEIGHT } from './use-editor-layout'
import { useFilmSession } from './use-film-session'
import { useMaterials } from './use-materials'
import { usePreviewPlayback } from './use-preview-playback'
import { useSideSelection } from './use-side-selection'
import { useSoundControls } from './use-sound-controls'
import { useStageFullscreen } from './use-stage-fullscreen'
import { useStagePreview } from './use-stage-preview'
import { useTimelineZoom } from './use-timeline-zoom'
import { useTrackPlacement } from './use-track-placement'
import { useVoiceControl } from './use-voice-control'
import { useVoicePicking } from './use-voice-picking'
import { useWholeFilmExport } from './use-whole-film-export'
import { VoicePicker } from './voice-picker'
import { useProjectQuery, wholeFilmQueryKeys, type StoredProject } from './final-cut.api'
import './final-cut.css'

const EMPTY_TEXT = 'final-cut 暂无内容，加入内容后可在此预览'
const EMPTY_EXPORT_TEXT = 'final-cut 暂无内容，无法导出；请先加入内容'
const NO_LINKS: Links = new Map()
const NO_BINDINGS: ReadonlyMap<string, LocaleBindings> = new Map()

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

/**
 * 打开着的 final-cut 编辑器：持有编辑会话和各块状态（素材、播放、选中与右栏、时间线缩放、片段操作、声音、入轨、
 * 快捷键、预览、字幕工具、配音），再交给舞台、右栏和时间线面板摆放。各 `use*` 的调用先后就是它们副作用的先后，
 * 不要随意调换。
 */
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
  const empty = film === null || film.clips.length === 0
  const links = film?.links ?? NO_LINKS
  const videoClips = useMemo(() => clips.filter((clip) => clip.kind === 'video'), [clips])
  const [itemFilters, setItemFilters] = useState<Readonly<Record<ItemKind, ItemFilter>>>({
    component: NO_FILTER,
    block: NO_FILTER,
  })
  const previewRef = useRef<PreviewControl | null>(null)
  const materials = useMaterials(conversationId, videoClips, previewRef)
  const { materialView, leaveMaterial, videos, sourceNames, keyframes, picks, setPicks, takeOf } =
    materials
  const collapsed = useWorkbenchCollapsed()
  const player = usePreviewPlayback({ film, previewRef, materials, collapsed })
  const { total, playheadNow, seek, togglePlay, toggleMute, toggleLoop } = player
  // 画面编辑层处理方向键的函数（见 CanvasOverlay）
  const canvasNudgeRef = useRef<CanvasNudge | null>(null)
  const screen = useStageFullscreen(notice)
  const { fullscreen, exitFullscreen, toggleFullscreen } = screen
  const selection = useSideSelection(clips, root, screen.stage)
  const {
    setSelectedIds,
    selectedClips,
    selected,
    clearSelection,
    sideTab,
    sideRef,
    sideScroll,
    timelinePanelRef,
    layout,
    sideSplitter,
    timelineSplitter,
    openSideTab,
  } = selection
  const zoom = useTimelineZoom(total, playheadNow, selectedClips)
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
  const commands = useClipCommands({ session, clips, links, selection, player, materials, notice })
  const { selectAround, splitAtPlayhead, sourceMs, removeSelected } = commands
  const allClips = useMemo(() => [...clips, ...(film?.unshownDubs ?? [])], [clips, film])
  const sound = useSoundControls({
    conversationId,
    session,
    clips,
    allClips,
    selection,
    materials,
    sourceMs,
    timelineRef: zoom.timelineRef,
    notice,
  })
  const placement = useTrackPlacement({
    session,
    film,
    clips,
    allClips,
    locale,
    zoom,
    musicBeats: sound.musicBeats,
    player,
    materials,
    notice,
  })
  const history = {
    canUndo: film?.canUndo ?? false,
    canRedo: film?.canRedo ?? false,
    undo: session.undo,
    redo: session.redo,
  }
  useEditorShortcuts(keysRef, root, {
    gesturing,
    history,
    leaveMaterial,
    insert: placement.insert,
    runSoundAction: sound.runSoundAction,
    togglePlay,
    toggleMute,
    toggleLoop,
    toggleFullscreen,
    selected,
    removeSelected,
    selectAround,
    zoomToSelection: zoom.zoomToSelection,
    splitAtPlayhead,
    setTool,
    canvasNudgeRef,
    seek,
    total,
    playheadNow,
  })

  const preview = useStagePreview(conversationId, film, catalog, session.filesRevision)
  const playBlocked = empty ? EMPTY_TEXT : undefined

  const exporting = useWholeFilmExport(conversationId, session.settle)
  const [chosenTier, chooseTier] = useChosenTier(conversationId)
  const exportBlocked = empty ? EMPTY_EXPORT_TEXT : film.captionsProblem

  const captionTools = useCaptionTools({
    conversationId,
    film,
    catalog,
    session,
    clips,
    captions,
    locale,
    playhead: player.playhead,
    materials,
    selection,
    collapsed,
    notice,
  })
  const { pending } = captionTools
  // 「字幕」页签和「属性」里改字幕的字：改的是文字框所在的那种语言
  const setCaptionText = (id: string, text: string, code: Language) => {
    leaveMaterial()
    session.setCaptionText(id, text, code)
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
  const picking = useVoicePicking({
    voice,
    locale,
    sideTab,
    sideVisible,
    clips,
    allClips,
    notice,
  })
  const { shownPick, sideAudition, closeVoicePicker, libraryVoices, voicesProblem } = picking
  const dubLooks = dubLooksOf(clips, voice, libraryVoices.data)
  // 时间线上还没有配音行时，在配音行的位置写一句去哪里配
  const dubHint =
    voice === undefined || captions.length === 0 || clips.some(isDubClip)
      ? null
      : voice.mode === 'original'
        ? '当前语言保留原声；在「字幕」页签切到「配音」可生成配音'
        : '当前语言还没有配音；在「字幕」页签点击「生成配音」'
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

  if (film === null)
    return (
      <p className="wf-state" role="status">
        正在打开 final-cut…
      </p>
    )

  const exportTier = exportTierOf(film.canvas, chosenTier)

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
      <EditorStage
        canvasNudgeRef={canvasNudgeRef}
        catalog={catalog}
        clips={clips}
        exportTier={exportTier}
        film={film}
        locale={locale}
        materials={materials}
        onCaptionText={setCaptionText}
        onGesture={setGesturing}
        onNotice={notice}
        onSelect={setSelectedIds}
        onText={itemTexts.onText}
        onTier={chooseTier}
        playBlocked={playBlocked}
        player={player}
        preview={preview}
        previewRef={previewRef}
        root={root}
        screen={screen}
        selected={selected}
        session={session}
        videoClips={videoClips}
      />
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
      <EditorSide
        captionTools={captionTools}
        captions={captions}
        catalog={catalog}
        clips={clips}
        commands={commands}
        conversationId={conversationId}
        film={film}
        itemFilters={itemFilters}
        itemTexts={itemTexts}
        locale={locale}
        localeControls={localeControls}
        materials={materials}
        onCaptionText={setCaptionText}
        onGesture={setGesturing}
        onItemFilters={setItemFilters}
        onNotice={notice}
        onTextEditing={setTextEditing}
        picking={picking}
        placement={placement}
        player={player}
        selection={selection}
        session={session}
        showCaptions={showCaptions}
        sideVisible={sideVisible}
        sound={sound}
        videoClips={videoClips}
        voice={voice}
      />
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
      <EditorTimelinePanel
        captions={captions}
        catalog={catalog}
        clips={clips}
        commands={commands}
        dubHint={dubHint}
        dubLooks={dubLooks}
        film={film}
        gesturing={gesturing}
        history={history}
        links={links}
        locale={locale}
        localeControls={localeControls}
        materials={materials}
        onGesture={setGesturing}
        onTool={setTool}
        placement={placement}
        player={player}
        selection={selection}
        session={session}
        sound={sound}
        tool={tool}
        zoom={zoom}
      />
    </div>
  )
}
