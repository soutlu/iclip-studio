import { useEffect } from 'react'
import type { CanvasLayer } from './canvas-layers'
import type { Links } from './clip-edit'
import type { CaptionStyle } from './composition/captions'
import type { ComponentCatalog } from './composition/catalog'
import type { AudioClip, Canvas, FilmClip, VideoClip } from './composition/film'
import type { LocaleBindings } from './composition/locale-text'
import type { VoiceMode, VoiceModes } from './composition/voices'
import { disposeAll } from './film-files'
import type { StoredProject } from './final-cut.api'
import type { LocaleCode, ShownLocale } from './locales'
import type { UndoStep } from './undo-history'
import { useCanvasEdits } from './use-canvas-edits'
import { useCaptionEdits } from './use-caption-edits'
import { useClipEdits } from './use-clip-edits'
import { useFilmProject } from './use-film-project'
import { useFilmSaving } from './use-film-saving'
import { useLocaleEdits } from './use-locale-edits'
import { useSoundEdits } from './use-sound-edits'
import { useVoiceEdits } from './use-voice-edits'

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; message: string }

/** 工程现在的样子：`html` 是当前的主文件（没存的改动也在里面），其余是从工程里的文件读出来的。 */
export type FilmView = {
  html: string
  canvas: Canvas
  /** 画布底色：优先取根节点行内样式，未设置时回退至 `<head>` 模板底色（见 `headBackground`），均无法解析时为 `null`。 */
  background: string | null
  /**
   * 主文件根下所有带时间的元素（字幕宿主除外），按它们在文件里的先后；后面跟着字幕场景里的各句字幕，
   * 按它们在场景里的先后。配音片段只有当前显示的语言 AI 配音时这种语言的，和原文下、保留原声时的旁白（见
   * `shownIn`）。
   */
  clips: readonly FilmClip[]
  /**
   * 没显示的配音片段（见 `shownIn`：别的语言的、当前语言原声时这种语言的、配音时原文的、原声时原文下属于视频片段
   * 的字幕的）：新开一行时它们也要跟着重新编号（见 `rowOpeningAmong`）。
   */
  unshownDubs: readonly FilmClip[]
  /** 当前显示的语言（原文也是）出不出配音（见 `voices.ts`）。 */
  voiceMode: VoiceMode
  /** 主文件根上记的各语言人声设置（见 `voices.ts`，原文的键是 `SOURCE_VOICES`）。 */
  voiceModes: VoiceModes
  /** 带链接（`data-link`）的片段各自的链接名。 */
  links: Links
  durationMs: number
  /** 字幕写法不对时的原因（见 `captionsProblem`），导出前要先改好。 */
  captionsProblem: string | undefined
  /** 字幕场景文件的路径（相对工程根）和现在的内容（没存的改动也在里面）；工程里还没有时是 null。 */
  captionsScene: { path: string; content: string } | null
  /** 字幕样式（字幕场景里字幕样式规则设的，见 `captions.ts`）：没设的项、还没有字幕场景时都是 null。 */
  captionStyle: CaptionStyle
  /**
   * 当前显示的语言和它的值表（原文时是 null）。`clips` 里字幕的 `text` 总是原文，名字取这种语言的字
   * （还没翻的取原文）；预览按值表套上这种语言。
   */
  locale: ShownLocale
  /** 工程里有值表的语言，按 `LOCALES` 的先后。 */
  locales: readonly LocaleCode[]
  /** 组件或块的片段里随语言的文字字段（片段编号 → 字段到根变量），没有随语言字段的片段不在里面。 */
  bindings: ReadonlyMap<string, LocaleBindings>
  /** 画布可编辑图层与元素/模板宿主表（见 canvas-layers.ts），按主文件与字幕场景当前内存内容派生。 */
  layers: readonly CanvasLayer[]
  canUndo: boolean
  canRedo: boolean
  /** 第几份：会话每换一份加 1。 */
  revision: number
  /**
   * 从上一份（`revision - 1`）到这一份做的那一步编辑（编辑动作、撤销、重做）里各文件的改动，按发生的先后；
   * 不是编辑换的（打开、换语言、换成别处改的那一份……）时是 null。
   */
  step: UndoStep | null
}

/**
 * 画布图层变更项：指定目标文件相对路径与元素 `data-hf-id`；
 * `move` 为 SDK `moveElement` 写入的 `data-x` / `data-y`，`styles` 为待更新的行内样式（SDK 驼峰属性名，`null` 表示移除）。
 */
export type LayerEdit = {
  file: string
  element: string
  move?: { x: number; y: number }
  styles?: Readonly<Record<string, string | null>>
}

/** 要放进工程的一段素材；起点由现有内容决定，接在画面那一行的末尾。 */
export type NewVideo = Pick<VideoClip, 'label' | 'src' | 'mediaStart' | 'duration' | 'muted'>

/** 要放进工程的一段音频：一条音频记录从 `mediaStart` 起的 `duration` 毫秒。 */
export type NewAudio = Pick<AudioClip, 'label' | 'src' | 'mediaStart' | 'duration'>

type Options = {
  debounceMs?: number | undefined
  onNotice: (message: string) => void
  /** 工作区主文件已被外部删除：会话已卸载工程并停止保存，通知调用方退回无工程态。 */
  onMissing: () => void
}

/**
 * 管理对话工作区 final-cut 工程编辑会话：加载主文件 `final-cut/index.html`、关联字幕场景文件及各语言值表（`initial` 见 `readProject`），
 * 编辑停手 `debounceMs` 毫秒后按乐观锁版本号整份保存变更文件（先存附属文件、最后存主文件）。初始化未完成期间 `film` 为 `null`。
 * 若任一已打开文件被外部修改或保存返回版本冲突，则重载工作区最新版本并放弃未保存改动；若主文件已缺失则触发 `onMissing`。
 * 工程内其余资产文件变更时递增 `filesRevision` 以触发预览重载。会话初始展示语言为原文。
 */
export function useFilmSession(
  conversationId: string,
  initial: StoredProject,
  catalog: ComponentCatalog,
  { debounceMs = 800, onNotice, onMissing }: Options,
) {
  const session = useFilmProject(initial, catalog, onNotice, onMissing)
  const { film, projectRef, contentOf, setLocale, step } = session
  const { save, filesRevision, saveNow } = useFilmSaving(conversationId, debounceMs, session)
  // 要在 `useFilmSaving` 的副作用之后：卸载时先补存、再关掉引擎
  useEffect(() => () => disposeAll(projectRef.current), [projectRef])
  const { addVideos, addItem, addAudio, retime, moveClip, restart, setHidden, removeClips, split } =
    useClipEdits(conversationId, catalog, session)
  const { editLayers, resize, setBackground } = useCanvasEdits(session)
  const { setValues, setItemText, setFollowsLocale, fillLocale, addLocale } = useLocaleEdits(
    conversationId,
    catalog,
    session,
  )
  const {
    setAttributes,
    setCarve,
    setLeveller,
    setFx,
    setAutomation,
    detach,
    merge,
    setLinked,
    resync,
  } = useSoundEdits(catalog, session)
  const { addCaptions, setCaptionText, setCaptionStyle, setCaptionTrackStyle, setCaptionOwnStyle } =
    useCaptionEdits(conversationId, catalog, session)
  const { setVoiceMode, changeVoice, addDubs } = useVoiceEdits(catalog, session)

  return {
    film,
    filesRevision,
    addVideos,
    addItem,
    addAudio,
    retime,
    moveClip,
    restart,
    setHidden,
    editLayers,
    resize,
    setBackground,
    contentOf,
    setValues,
    setAttributes,
    setCarve,
    setLeveller,
    setFx,
    setAutomation,
    removeClips,
    split,
    detach,
    merge,
    setLinked,
    resync,
    addCaptions,
    setCaptionText,
    setCaptionStyle,
    setCaptionTrackStyle,
    setCaptionOwnStyle,
    setItemText,
    setFollowsLocale,
    fillLocale,
    setVoiceMode,
    changeVoice,
    addDubs,
    setLocale,
    addLocale,
    undo: () => step('undo'),
    redo: () => step('redo'),
    save,
    flush: () => void saveNow(),
    /** 等没存的改动存完；存好了（或本来就没有要存的）答 true，存失败或换成了别处改的那一份答 false。 */
    settle: async () => {
      const outcome = await saveNow()
      return outcome === 'saved' || outcome === 'clean'
    },
  }
}
