import {
  Fragment,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon, type IconName } from '@/shared/icons'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { useAudioPeaks, type PeaksState } from '../editing/media-analysis'
import { timeLabel } from '../editing/time-label'
import { Frames, TimelinePlayhead, TimelineRuler, TrimHandle, Wave } from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
  type Edge,
} from '../editing/timeline-drag'
import { useStableValue } from '../editing/use-stable-value'
import {
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSurface,
  ContextMenuTrigger,
} from '@/shared/ui/menu'
import {
  editGroup,
  gapClosing,
  groupShift,
  groupTrimmed,
  groupTrimRange,
  playheadSplit,
  razorSplit,
  splitAllAt,
  timingOf,
  type Cut,
  type GapClosing,
  type Links,
  type SourceLength,
  type Timing,
} from './clip-edit'
import { canCarve, carveOf } from './carve'
import { ClipEnvelope } from './clip-envelope'
import { ClipMenuItems } from './clip-menu'
import { thumbnailUrl, type ComponentCatalog } from './component-catalog'
import {
  isDetachedAudio,
  isDubClip,
  isMediaClip,
  type AudioClip,
  type FilmClip,
  type MediaClip,
} from './composition/film'
import type { DubLook } from './dub-look'
import { useEditorEscape, useEditorRoot } from './editor-keys'
import type { EditTool } from './editor-toolbar'
import type { AttributeChanges } from './original-sound'
import {
  namedRows,
  rowHidden,
  rowsOf,
  sameRow,
  targetIn,
  zoneOf,
  type Aim,
  type Row,
  type RowKey,
  type RowKind,
  type RowTarget,
  type Zone,
} from './placement'
import { usePlayheadClock, type PlayheadClock } from './playhead-clock'
import { boxBetween, marqueeMode, marqueeSelection, playheadInto, type Box } from './selection'
import {
  soundActionFor,
  soundBadgeOf,
  soundPairOf,
  type SoundBadge,
  type SoundControls,
} from './sound-pair'
import { BeatMarks } from './beat-marks'
import {
  beatsToSnap,
  clipBeats,
  isBeatSource,
  shownBeats,
  snapEdgeToBeats,
  snapSpanToBeats,
  timelineBeats,
  type BeatGrid,
  type TimelineBeat,
} from './music-beats'
import { msToPx, pxToMs, snapTargets, type TimelineScale } from './timeline-scale'
import { clipLevel, volumePointsOf, type EnvelopePoint } from './volume-envelope'

/** 素材拖进来时落在哪：哪一行（或新开的一行）、final-cut 的第几毫秒。 */
export type TimelinePoint = { row: RowTarget; timeMs: number }

export type TimelineHandle = {
  /**
   * 屏幕上的这个点给 `zone` 区的素材落在哪一行、对应 final-cut 的第几毫秒；不在任何一行上时是 null。
   * 画面区的素材对着两行之间的缝时归离得近的那一行，声音区的素材和拖片段一样在缝里新开一行。
   */
  locate: (clientX: number, clientY: number, zone: Zone) => TimelinePoint | null
  /** 时间线现在横向滚到的位置（像素）。 */
  scrollLeft: () => number
  /** 把这个片段滚到看得见的地方。 */
  reveal: (id: string) => void
}

/** 拖着的素材会落在哪里：`duration` 是它的总长（毫秒），`guideMs` 是它吸上的时间点。 */
export type DropGhost = { row: RowTarget; start: number; duration: number; guideMs: number | null }

type FilmTimelineProps = {
  /** final-cut 里所有的片段。 */
  clips: readonly FilmClip[]
  /** 显示着的语言下没字的字幕（没翻的、空着的）：片段上写「待输入字幕」。 */
  blankCaptions: ReadonlySet<string>
  /** 各配音片段顶行的样子（见 `dubLooksOf`），按片段编号。 */
  dubLooks: ReadonlyMap<string, DubLook>
  /**
   * 还没有配音行时，在声音区最上面（配音行生成后在的地方）占一行写的引导；不用引导时是 null。
   * 它下面的位置拖得进片段时，拖到它上面就在那里新开一行。
   */
  dubHint: string | null
  /** 显示着的语言在配音：视频片段的原声不出声。 */
  dubbing: boolean
  /** 元素或模板片段在当前展示语言下的正文内容，用于悬停提示拼接为「名称 · 正文」；无文本时省略。 */
  hostTexts: ReadonlyMap<string, string>
  /** 片段的链接名：链接的片段一起切。 */
  links: Links
  /**
   * 点下去做什么。切开（剃刀）时点片段在点的地方切开它、按着 Shift 点切开那个时间上所有的片段，
   * 不选中、不拖动、不框选、不裁剪。
   */
  tool: EditTool
  /** 切开几个片段（剃刀，或右键菜单里的「在播放头处切开」）。 */
  onSplit: (cuts: readonly Cut[]) => void
  /** 组件库目录：供元素与模板片段读取平铺封面图。 */
  catalog: ComponentCatalog
  totalMs: number
  /** 播放头节流时刻（播放期间约每 0.1 秒同步一次），供吸附、切开提示与时间尺计算。 */
  playheadMs: number
  /** 播放头实时时钟源：播放头竖线直接订阅，实现播放期间逐帧移动而不触发整条时间线重绘。 */
  clock: PlayheadClock
  buffered: readonly TimeSpan[]
  scale: TimelineScale
  ghost: DropGhost | null
  /** 选中的片段。 */
  selected: ReadonlySet<string>
  /** 拖动和裁剪时要不要吸到别的片段的两端和播放头上，都没吸上时再吸配乐的节拍。 */
  snap: boolean
  /** 配乐算出来的节拍，按音频地址；还没算出来、算不出来的不在里面。 */
  beats: ReadonlyMap<string, BeatGrid>
  /** 视频片段、音频片段素材的总长（毫秒），还没读到时是 undefined；裁结尾时不超出它。 */
  sourceMs: SourceLength
  /** 换成这些选中的片段（空的就是全部取消）。 */
  onSelect: (ids: ReadonlySet<string>) => void
  /** 双击了一个片段：只选中它，侧栏切到「属性」。 */
  onInspect: (id: string) => void
  /** 开始或结束框选、拖片段；中途按 Esc 由时间线自己取消。 */
  onGesture: (active: boolean) => void
  /** 正在拖片段、框选或拖「原片截取」：这时点右键不出菜单，不打断它。 */
  gesturing: boolean
  /** 给了就把时间线横向滚到 `left`（像素）；每次给新的对象才滚。 */
  scrollRequest: { left: number } | null
  /** 改几个片段各自的起止和入点（在行里挪、裁剪），一起算一步。 */
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /**
   * 把片段换到另一行（或新开的一行）的 `start` 处；`starts` 是和它一起挪的片段各自的新起点，
   * 它们留在原来的行。
   */
  onMove: (id: string, row: RowTarget, start: number, starts: ReadonlyMap<string, number>) => void
  /** 把几个片段各自挪到新的起点（合拢空档用）。 */
  onRestart: (starts: ReadonlyMap<string, number>) => void
  /** 选中的片段波形上改了音量曲线：换成这些点，一步撤销。 */
  onEnvelope: (id: string, points: readonly EnvelopePoint[]) => void
  /** 把 `row` 这一行的片段一起隐藏（`hidden` 为真，声音区的行就是静音）或显示回来。 */
  onHide: (row: RowKey, hidden: boolean) => void
  /** 片段右键菜单：隐藏或显示一个片段（音频片段就是静音）。 */
  onHideClip: (id: string, hidden: boolean) => void
  /** 片段右键菜单：改片段上的几个属性（视频片段的静音）。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 片段右键菜单：删掉选中的片段，和按 Delete 一样。 */
  onRemove: () => void
  /** 这个地址的视频素材确认没有声音。 */
  silentSource: (src: string) => boolean
  /** 片段右键菜单：分离音频、合并回视频、联动、对齐口型、选中另一段。 */
  soundControls: SoundControls
  onSeek: (ms: number) => void
  /** 点选片段后把播放头挪进它里面：一次普通的定位，正在播放时接着播。 */
  onJump: (ms: number) => void
  onViewportWidth: (width: number) => void
  handleRef: RefObject<TimelineHandle | null>
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/** 当前语言下没字（没翻、空着）的字幕片段上写的字。 */
const BLANK_CAPTION = '待输入字幕'

/**
 * 静音（隐藏）音频片段的角标：配乐行显示「已静音」，配音显示「静音」（分离原声由 `soundBadgeOf` 负责）；静音片段仅展示此角标。
 */
const mutedBadgeOf = (clip: FilmClip): SoundBadge | undefined =>
  clip.kind === 'audio' && clip.hidden
    ? { text: isDubClip(clip) ? '静音' : '已静音', tone: 'muted' }
    : undefined

/** 自动避让开启态角标：音频片段顶行画成压低图标加「自动避让」，视频片段上只画图标（文字写进无障碍名称）。 */
const CARVE_BADGE: SoundBadge = { text: '自动避让', tone: 'linked' }

/** 开启自动避让的有声片段角标；静音（隐藏）片段不出声，不展示。 */
const carveBadgeOf = (clip: FilmClip): SoundBadge | undefined =>
  canCarve(clip) && !clip.hidden && carveOf(clip)?.enabled === true ? CARVE_BADGE : undefined

// 指针距待新建空行上下边缘在该像素内即判定悬停命中
const ROW_REACH_PX = 3

// 各轨道行上距播放头竖线左右 6px 内按下即视作抓起播放头竖线
const PLAYHEAD_REACH = 6

/** 按下的元素所在的片段（片段的身体、把手、音量曲线都算）；不在片段上时是 undefined。 */
const clipIdAt = (target: EventTarget): string | undefined =>
  target instanceof Element
    ? target.closest<HTMLElement>('[data-clip-id]')?.dataset['clipId']
    : undefined

/**
 * 在竖线上按下、还没拖开的这一下：没挪过 `DRAG_THRESHOLD` 就松手当作点了下面的东西（`clip` 是下面的片段，
 * 空白处是 null），挪过了才开始拖播放头（`started`）。
 */
type PlayheadPress = {
  pointerId: number
  originX: number
  originY: number
  clip: string | null
  started: boolean
}

// 时间区左右留的空，露出开头的播放头和两端的把手；不算进能排时间的宽度。只在这里定，时间区的外边距用它
const INSET = { left: 8, right: 6 }

const rowKeyOf = (clip: FilmClip): RowKey => ({ zone: zoneOf(clip), track: clip.track })

/**
 * 一条行在屏幕上的上下边；`insertAt` 是待新开的那一行在第几行的位置，已有的行是 null；`hint` 是配音行的引导那一行
 * （它顶着的位置不是让出来的）。
 */
type Lane = { top: number; bottom: number; insertAt: number | null; hint: boolean }

/**
 * 别处让出了一行（`opened`）时，各行按没让出来的样子摆回去：它下面的行往上挪回它占的高度，
 * 最下面那条空行（让行时收起来了）回到最后一行下面。片段只能在自己的区里新开一行，让出来的这一行
 * 常常不在指针下面；按让完的样子量，指针下面换成了别的行，又会把这一行收回去，来回跳。
 */
const withoutOpening = (lanes: readonly Lane[], opened: Lane): Lane[] => {
  const rest = lanes.filter((lane) => lane !== opened)
  const after = rest.find((lane) => lane.top > opened.top)
  const shift = after === undefined ? 0 : after.top - opened.top
  const restored = rest.map((lane) =>
    lane.top > opened.top ? { ...lane, top: lane.top - shift, bottom: lane.bottom - shift } : lane,
  )
  const last = restored.at(-1)
  if (last === undefined) return restored
  const height = opened.bottom - opened.top
  return [
    ...restored,
    {
      top: last.bottom + shift - height,
      bottom: last.bottom + shift,
      // 已有的行有几行，最下面那条空行就在第几行的位置（配音行的引导不是一行）
      insertAt: restored.filter((lane) => lane.insertAt === null).length,
      hint: false,
    },
  ]
}

/** `row` 在页面上是哪一条：已有的行，或者待新开的那一行（让出来的空行、最下面那条空行）。 */
const laneOf = (content: HTMLElement | null, row: RowTarget) =>
  content?.querySelector<HTMLElement>(
    'track' in row
      ? `[data-zone="${row.zone}"][data-track="${row.track}"]`
      : `[data-insert-at="${row.insertAt}"]`,
  ) ?? null

/** 按着 Shift、⌘ 或 Ctrl 点片段是逐个加减选中。 */
const togglesSelection = (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
  event.shiftKey || event.metaKey || event.ctrlKey

/** 在行的空白处按下：拖过一点就是框选，没拖就是点空白处。 */
type Framing = {
  pointerId: number
  /** 按下的点，按时间区左上角算，框选中途滚动也不跑。 */
  origin: { x: number; y: number }
  /** 按下时带着 ⌘ 或 Ctrl：框住的加进原有选中。 */
  adding: boolean
  /** 按下时的选中，框选在它上面换、加或减。 */
  base: ReadonlySet<string>
  /** 触摸按下只算点一下，拖动留给滚动。 */
  canFrame: boolean
  started: boolean
}

/** 正在框选：框在哪（按时间区左上角算），松手的话会选中哪些片段。 */
type Marquee = { box: Box; ids: ReadonlySet<string> }

const sameTiming = (left: Timing, right: Timing) =>
  left.start === right.start &&
  left.duration === right.duration &&
  left.mediaStart === right.mediaStart

type Gesture = {
  pointerId: number
  kind: 'move' | Edge
  originX: number
  originY: number
  /** 按下的地方离片段的开头多远（毫秒），挪的时候片段跟着指针走而不是跳到指针处。 */
  grabMs: number
  /** 一起动的片段（含它自己）：开始拖的那一刻定下来，中途选中变了也不换；还没开始拖时是 null。 */
  group: ReadonlySet<string> | null
  timing: Timing | null
  /** 挪的时候片段要去哪一行：已有的行，或者要新开的那一行。 */
  row: RowTarget | null
  /** 跟着一起动的别的片段各自的时间。 */
  followers: ReadonlyMap<string, Timing>
}

/** 拖动中的片段按这个画：时间、正在拖的是哪一部分、要去哪一行（裁剪时是 null）。 */
type Preview = { timing: Timing; kind: Gesture['kind']; row: RowTarget | null }

/** 成组拖动中跟着动的片段按这个画：拖的是哪一部分，各自的时间。 */
type Following = { kind: Gesture['kind']; timings: ReadonlyMap<string, Timing> }

/** 一个片段这一端在 final-cut 里的时间（毫秒）。 */
const edgeAt = (clip: Timing, edge: Edge) =>
  edge === 'start' ? clip.start : clip.start + clip.duration

/** `timings` 里和 final-cut 里现在不一样的那些。 */
const changedTimings = (
  clips: readonly FilmClip[],
  timings: ReadonlyMap<string, Timing>,
): Map<string, Timing> =>
  new Map(
    [...timings].filter(([id, timing]) => {
      const clip = clips.find((other) => other.id === id)
      return clip !== undefined && !sameTiming(timing, timingOf(clip))
    }),
  )

/** 挪动的落点：被抓的片段去哪一行、从哪里起，跟着走的片段各自的新时间。 */
type MovePlan = { row: RowTarget; start: number; followers: Map<string, Timing> }

/**
 * 被抓的 `clip` 想从 `startMs` 起、去 `row` 这一行时，它和一起挪的片段（`group`，含它自己）落在哪里。
 * 一起挪的片段挪同一个时间差，跟着走的片段留在各自的行；被抓的片段换不过去就留在自己那一行。
 * 只挪一个片段也走这里，它自己就是一组。
 */
const movePlan = (
  clips: readonly FilmClip[],
  clip: FilmClip,
  group: ReadonlySet<string>,
  startMs: number,
  row: RowTarget,
): MovePlan => {
  const shift = groupShift(
    clip,
    group,
    clips,
    startMs - clip.start,
    'track' in row ? row.track : null,
  )
  const followers = new Map(
    clips
      .filter((other) => group.has(other.id) && other.id !== clip.id)
      .map((other) => {
        const timing = timingOf(other)
        return [other.id, { ...timing, start: timing.start + shift.delta }]
      }),
  )
  return {
    row: shift.track === null ? row : { zone: zoneOf(clip), track: shift.track },
    start: clip.start + shift.delta,
    followers,
  }
}

/**
 * 片段状态角标：分离原声、静音以文字标签呈现；自动避让在音频片段顶行是压低图标加文字，在视频片段上只有图标
 * （`iconOnly`）。
 */
function ClipBadge({ badge, iconOnly = false }: { badge: SoundBadge; iconOnly?: boolean }) {
  if (badge !== CARVE_BADGE)
    return (
      <span aria-hidden="true" className="wf-clip-badge" data-tone={badge.tone}>
        {badge.text}
      </span>
    )
  return iconOnly ? (
    <Icon className="wf-clip-duck" decorative name="final-cut-duck" size="xs" />
  ) : (
    <span aria-hidden="true" className="wf-clip-badge" data-tone={badge.tone}>
      <Icon decorative name="final-cut-duck" size="xs" />
      {badge.text}
    </span>
  )
}

/**
 * 渲染时间线片段主体内容：画面类片段不叠加文字（视频平铺抽帧且未分离原声时底部叠加细原声波形；元素与模板片段平铺封面帧条，名称与文本由悬停提示展示）；
 * 字幕渲染为写着正文的胶囊（当前语言下没字时写「待输入字幕」）；音频顶行写名字（配音片段是音色的小图标、音色名和
 * 加速倍数）和状态角标，下面是贴底波形；「其他」片段仅展示名称。
 */
function ClipContent({
  clip,
  timing,
  cover,
  badge,
  blank,
  dub,
  keyframes,
  withSound,
  peaks,
  wave,
  waveRef,
}: {
  clip: FilmClip
  timing: Timing
  cover: string | null
  badge: SoundBadge | undefined
  /** 字幕片段在当前语言下没字。 */
  blank: boolean
  /** 配音片段顶行的样子；别的片段是 undefined。 */
  dub: DubLook | undefined
  /** 是否存在音量关键帧：音频片段在标题条内标注（视频片段直接通过包络曲线体现）。 */
  keyframes: boolean
  /** 视频片段是否仍保留原声（未分离）：为真时底部叠加原声波形。 */
  withSound: boolean
  peaks: PeaksState
  /** 有声片段波形绘制参数：相对增益、是否静音置灰及是否含音量包络。 */
  wave: ClipWave
  /** 波形容器引用，供音量包络层对齐叠加。 */
  waveRef: RefObject<HTMLSpanElement | null>
}) {
  const name = <span className="wf-clip-name">{clip.label}</span>
  if (clip.kind === 'other') return name
  if (clip.kind === 'caption')
    return blank ? <span className="wf-clip-name is-blank">{BLANK_CAPTION}</span> : name
  if (clip.kind === 'host')
    return cover === null ? null : (
      // 片段宽度随缩放动态变化，使用 background-repeat 横向平铺封面图避免手动计算张数
      <span className="wf-clip-strip" style={{ backgroundImage: `url("${cover}")` }} />
    )
  // 片段展示对应的素材区间：轨道时长 × 播放倍速
  const part = {
    mediaUrl: clip.src,
    start: timing.mediaStart / 1000,
    end: (timing.mediaStart + timing.duration * clip.playbackRate) / 1000,
  }
  const waveClass = cn(wave.silent && 'is-silent', wave.envelope && 'has-envelope')
  if (clip.kind === 'audio')
    return (
      <>
        <span className="wf-clip-label">
          {dub === undefined ? (
            name
          ) : (
            <>
              <Icon
                className="wf-clip-voice"
                decorative
                name={dub.glyph ?? 'final-cut-voice'}
                size="xs"
              />
              <span className="wf-clip-name">{dub.voice}</span>
              {dub.speed === undefined ? null : (
                <span
                  aria-hidden="true"
                  className="wf-clip-badge"
                  data-tone={dub.trimmed ? 'offset' : 'muted'}
                >
                  {dub.speed}
                </span>
              )}
            </>
          )}
          {badge === undefined ? null : <ClipBadge badge={badge} />}
          {keyframes ? (
            <span aria-hidden="true" className="wf-clip-badge wf-clip-keyframes">
              关键帧
            </span>
          ) : null}
        </span>
        <span className={cn('wf-clip-sound', waveClass)} ref={waveRef}>
          <Wave bars="bottom" level={wave.level} part={part} state={peaks} />
        </span>
      </>
    )
  // 底部原声波形条仅 7px 高，容不下状态提示文案，仅在波形数据就绪后叠加展示
  return (
    <>
      <span className="wf-clip-frames">
        <Frames part={part} />
      </span>
      {withSound && peaks.kind === 'ready' ? (
        <span className={cn('wf-clip-wave', waveClass)} ref={waveRef}>
          <Wave bars="bottom" level={wave.level} part={part} state={peaks} />
        </span>
      ) : null}
      {badge === undefined ? null : <ClipBadge badge={badge} iconOnly />}
    </>
  )
}

type ClipWave = {
  level: (fraction: number) => number
  silent: boolean
  envelope: boolean
}

/** 判定音频片段来源分类（分离原声、AI 配音或配乐），用于区分左缘色条、标题与波形主题色。 */
const soundSourceOf = (clip: AudioClip): 'original' | 'dub' | 'music' =>
  isDetachedAudio(clip) ? 'original' : isDubClip(clip) ? 'dub' : 'music'

/** 为片段主体包装悬停提示（`tip` 为 `undefined` 时直接透传）；拖拽、框选或裁剪期间（`quiet`）抑制显示。 */
function ClipTip({
  tip,
  quiet,
  children,
}: {
  tip: string | undefined
  quiet: boolean
  children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  if (tip === undefined) return children
  return (
    <TooltipRoot onOpenChange={setOpen} open={open && !quiet}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        {tip}
      </TooltipContent>
    </TooltipRoot>
  )
}

// 静音片段波形高度缩放系数
const SILENT_LEVEL = 0.22

const NO_POINTS: readonly EnvelopePoint[] = []

const NOTHING: ReadonlySet<string> = new Set()

/** 片段不出声：隐藏了（音频片段就是静音，整行静音也是），或者视频片段关了原声。 */
const isSilent = (clip: MediaClip) => clip.hidden || (clip.kind === 'video' && clip.muted)

type TimelineClipProps = {
  clip: FilmClip
  clips: readonly FilmClip[]
  selected: boolean
  /** 选中时画不画两端的把手：切开工具下不能裁剪，不画。 */
  trimmable: boolean
  /** 拖这个片段挪动或裁 `kind` 这一端时一起动的片段，含它自己和跟着动的联动伙伴。 */
  groupFor: (kind: Gesture['kind']) => ReadonlySet<string>
  /** 片段状态角标（分离原声、静音或自动避让，见 `ClipBadge`）；无角标时为 `undefined`。 */
  badge: SoundBadge | undefined
  /** 字幕片段在当前语言下没字（没翻、空着）。 */
  blank: boolean
  /** 配音片段顶行的样子（见 `DubLook`）；别的片段是 undefined。 */
  dub: DubLook | undefined
  /** 显示着的语言在配音：视频片段的原声不出声，底部的原声波形画暗。 */
  dubbing: boolean
  /** 别的片段正带着一组片段拖动时，跟着动的片段的样子；没有时是 null。 */
  following: Following | null
  pps: number
  /** 时间线内容区，用它把屏幕上的横坐标换成 final-cut 的时间。 */
  contentRef: RefObject<HTMLDivElement | null>
  /**
   * `zone` 区的片段拖到这个高度时落在哪一行，`between` 为真时两行之间也算（在那里新开一行）；
   * 不在任何一行上时是 undefined。
   */
  rowAt: (clientY: number, between: boolean, zone: Zone) => RowTarget | undefined
  /** 拖动中要在第几行的位置新开一行，那里先让出一行；不新开、松手后是 null。 */
  onOpening: (insertAt: number | null) => void
  /** `group` 里的片段一起裁 `edge` 这一端时，`clip` 这一端能到的范围（final-cut 的毫秒）。 */
  trimRange: (
    clip: FilmClip,
    group: ReadonlySet<string>,
    edge: Edge,
  ) => { min: number; max: number }
  /** `group` 里的片段一起裁 `edge` 这一端、`clip` 这一端拖到 `edgeMs` 时，各自的起止和入点。 */
  trimTo: (
    clip: FilmClip,
    group: ReadonlySet<string>,
    edge: Edge,
    edgeMs: number,
  ) => ReadonlyMap<string, Timing>
  /** 元素或模板片段的平铺封面图地址；无封面时为 `null`。 */
  cover: string | null
  /** 元素或模板片段悬停提示中接在名称后的正文摘要；无文本时为 `undefined`。 */
  text: string | undefined
  /** 视频片段是否仍保留原声（未分离）。 */
  withSound: boolean
  peaks: PeaksState
  snap: boolean
  /** 这个片段是配乐、算出了节拍时它那首的节拍，画在片段上；别的片段是 undefined。 */
  beatGrid: BeatGrid | undefined
  /** 各个配乐片段画出来、能吸上去的节拍，按片段编号。 */
  snapBeats: ReadonlyMap<string, readonly TimelineBeat[]>
  playheadMs: number
  /** 拖动中吸上了哪个时间点（毫秒），画一条线；没吸上或松手后是 null。 */
  onGuide: (ms: number | null) => void
  /** 成组拖动中跟着动的片段怎么画；不是成组、松手后是 null。 */
  onFollow: (following: Following | null) => void
  /** 开始或结束拖动。 */
  onGesture: (active: boolean) => void
  /** 正在拖片段、框选或裁剪（含这个片段自己的）：这时点右键不出菜单。 */
  gesturing: boolean
  /** 右键菜单里的几项。 */
  menu: ReactNode
  /**
   * 选中这个片段：`toggle` 为真时是把它加进选中或移出去，否则只选它。`clicked` 是点了一下（不是拖完松手、
   * 不是点右键）。
   */
  onSelect: (id: string, toggle: boolean, clicked: boolean) => void
  /** 双击了这个片段（切开工具下不算）。 */
  onInspect: (id: string) => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 把片段换到另一行的 `start` 处，`starts` 是一起挪的片段各自的新起点。 */
  onMove: (id: string, row: RowTarget, start: number, starts: ReadonlyMap<string, number>) => void
  /** 片段的音量曲线改成这些点（波形音量关键帧），一步撤销。 */
  onEnvelope: (id: string, points: readonly EnvelopePoint[]) => void
}

/**
 * 时间线上的一个片段：点一下选中（带 Shift、⌘ 或 Ctrl 是加减选中），拖着挪动（在这一行里，
 * 或者拖到自己的区里别的行、新开的一行上），选中后拖两端的把手裁剪；在不止一个片段的选中里时，
 * 选中的片段一起挪、一起裁。松手才写进 final-cut，拖动中按 Esc 什么都不写。
 * 点右键出它的菜单：它不在选中里时先只选中它，在选中里（含多选）时选中不变。
 */
function TimelineClip({
  clip,
  clips,
  selected,
  trimmable,
  groupFor,
  badge,
  blank,
  dub,
  dubbing,
  following,
  pps,
  contentRef,
  rowAt,
  onOpening,
  trimRange,
  trimTo,
  cover,
  text,
  withSound,
  peaks,
  snap,
  beatGrid,
  snapBeats,
  playheadMs,
  onGuide,
  onFollow,
  onGesture,
  gesturing,
  menu,
  onSelect,
  onInspect,
  onRetime,
  onMove,
  onEnvelope,
}: TimelineClipProps) {
  const editorRoot = useEditorRoot()
  const rootRef = useRef<HTMLDivElement>(null)
  const waveRef = useRef<HTMLSpanElement>(null)
  const media = isMediaClip(clip) ? clip : null
  const automation = media?.automation ?? null
  const saved = useMemo(() => volumePointsOf(automation), [automation])
  // 拖音量曲线中的样子：波形和线都按它画
  const [envelopeDraft, setEnvelopeDraft] = useState<EnvelopePoint[] | null>(null)
  const envelopePoints = envelopeDraft ?? saved
  const gestureRef = useRef<Gesture | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [preview, setPreview] = useState<Preview>()
  const aimed = preview?.row ?? null
  // 拖去别的行时把片段画到那一行上。那一行可能是这一次才让出来的，要等排好版再量它在哪
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const own = root.parentElement
    const target = aimed === null ? null : laneOf(contentRef.current, aimed)
    root.style.translate =
      own === null || target === null
        ? ''
        : `0 ${target.getBoundingClientRect().top - own.getBoundingClientRect().top}px`
  })
  const timing = preview?.timing ?? following?.timings.get(clip.id) ?? timingOf(clip)
  const durationSec = timing.duration / 1000
  const silent = media !== null && isSilent(media)
  const levelAt = media === null ? null : clipLevel(media, durationSec, envelopePoints)
  const wave: ClipWave = {
    level: (fraction) => (silent ? SILENT_LEVEL : (levelAt?.(fraction * durationSec) ?? 1)),
    // 配音时视频的原声不出声：波形照常高低，只画暗
    silent: silent || (dubbing && clip.kind === 'video'),
    envelope: saved !== null,
  }
  // 音频片段隐藏就是静音，小标上已经写着
  const states = [
    badge === undefined ? (clip.hidden ? '已隐藏' : null) : badge.text,
    blank ? BLANK_CAPTION : null,
    dub?.speed ?? null,
    dub?.stale === true ? '需重配' : null,
  ].filter((each) => each !== null)
  const name = [clip.label, `${seconds(timing.duration)} 秒`, ...states].join('，')

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  const press = (event: PointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0) return
    event.stopPropagation()
    clickAfterDrag.reset()
    // 带着加减选中的键按下只算点选，不开始拖
    if (togglesSelection(event)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const box = event.currentTarget.closest('[data-clip-id]')?.getBoundingClientRect()
    gestureRef.current = {
      pointerId: event.pointerId,
      kind,
      originX: event.clientX,
      originY: event.clientY,
      grabMs: box === undefined ? 0 : pxToMs(event.clientX - box.left, pps),
      group: null,
      timing: null,
      row: null,
      followers: new Map(),
    }
  }

  // 把手是哪一端从它自己身上读（TrimHandle 给开头那个加 is-start），这样两个把手共用一个处理函数
  const pressEdge = (event: PointerEvent<HTMLElement>) =>
    press(event, event.currentTarget.classList.contains('is-start') ? 'start' : 'end')

  const drag = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    // 挪动可以往上下拖去别的行；裁剪只看左右
    const moved =
      gesture.kind === 'move'
        ? Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY)
        : Math.abs(event.clientX - gesture.originX)
    if (gesture.timing === null && moved <= DRAG_THRESHOLD) return
    if (gesture.group === null) onGesture(true)
    // 开始拖的那一刻定下一起动的片段
    gesture.group ??= groupFor(gesture.kind)
    const members = gesture.group
    const at = timeAt(event.clientX)
    const { kind } = gesture
    // 开着吸附时：没在动的片段的两端和播放头是能吸上去的点（一起动的片段拖动前的边不算）；
    // 都没吸上时再吸没在动的配乐的节拍（配乐自己不吸自己的节拍）
    const targets = snap
      ? snapTargets(
          clips.filter((other) => !members.has(other.id)),
          playheadMs,
        )
      : null
    const beats = snap ? beatsToSnap(snapBeats, members) : []
    if (kind === 'move') {
      const wanted = Math.max(0, at - gesture.grabMs)
      const snapped =
        targets === null
          ? { ms: wanted, guideMs: null }
          : snapSpanToBeats(wanted, clip.duration, targets, beats, pps)
      // 指针在哪一行上，片段就去它自己的区里对着的那一行；在两行之间就在那里新开一行；都不是就留在原来的行
      const row = rowAt(event.clientY, true, zoneOf(clip)) ?? rowKeyOf(clip)
      const plan = movePlan(clips, clip, members, snapped.ms, row)
      gesture.timing = { ...timingOf(clip), start: plan.start }
      gesture.row = plan.row
      gesture.followers = plan.followers
      onOpening('insertAt' in plan.row ? plan.row.insertAt : null)
      // 吸上去的位置被别的片段占了、又挪开了，就不画吸附线
      onGuide(plan.start === snapped.ms ? snapped.guideMs : null)
    } else {
      const snapped =
        targets === null ? { ms: at, guideMs: null } : snapEdgeToBeats(at, targets, beats, pps)
      const timings = trimTo(clip, members, kind, snapped.ms)
      const next = timings.get(clip.id) ?? timingOf(clip)
      gesture.timing = next
      gesture.followers = new Map([...timings].filter(([id]) => id !== clip.id))
      onGuide(edgeAt(next, kind) === snapped.ms ? snapped.guideMs : null)
    }
    setPreview({ timing: gesture.timing, kind, row: gesture.row })
    onFollow(gesture.followers.size === 0 ? null : { kind, timings: gesture.followers })
  }

  /** 收起这次拖动的样子；拖动已经开始的才算结束一次拖动。 */
  const finish = () => {
    const started = (gestureRef.current?.group ?? null) !== null
    gestureRef.current = null
    setPreview(undefined)
    onGuide(null)
    onOpening(null)
    onFollow(null)
    if (started) onGesture(false)
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    releasePointer(event)
    finish()
    if (gesture.timing === null) return
    // 拖完松手也会来一次点击，那一次不算选中
    clickAfterDrag.swallow()
    if (gesture.row !== null && !sameRow(gesture.row, rowKeyOf(clip))) {
      const starts = new Map([...gesture.followers].map(([id, timing]) => [id, timing.start]))
      onMove(clip.id, gesture.row, gesture.timing.start, starts)
      return
    }
    const changed = changedTimings(
      clips,
      new Map([[clip.id, gesture.timing], ...gesture.followers]),
    )
    if (changed.size > 0) onRetime(changed)
  }

  // 拖动中按 Esc：取消这次拖动，什么都不写；之后松手带来的那次点击也不算选中
  useEditorEscape(preview !== undefined, () => {
    clickAfterDrag.swallow()
    finish()
  })

  // 拖着的片段中途被删掉或撤销掉：它留在时间线和编辑器里的拖动状态一起收起
  const abandon = useEffectEvent(() => {
    if ((gestureRef.current?.group ?? null) !== null) finish()
  })
  useEffect(() => () => abandon(), [])

  // 拖动中 final-cut 被换掉（撤销了，或者别处存了更新的一版）：松手会按换之前算好的位置写回去，
  // 所以取消这次拖动，之后松手带来的那次点击也不算选中
  const dropStale = useEffectEvent(() => {
    if ((gestureRef.current?.group ?? null) === null) return
    clickAfterDrag.swallow()
    finish()
  })
  useEffect(() => dropStale(), [clips])

  const nudge = (event: KeyboardEvent<HTMLElement>, edge: Edge) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const changed = changedTimings(
      clips,
      trimTo(clip, groupFor(edge), edge, edgeAt(timingOf(clip), edge) + Math.round(step * 1000)),
    )
    if (changed.size > 0) onRetime(changed)
  }

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <div
          aria-label={name}
          className={cn(
            'wf-clip',
            `is-${clip.kind}`,
            selected && 'is-selected',
            clip.hidden && 'is-hidden',
            dub?.stale === true && 'is-stale',
            preview?.kind === 'move' && 'is-lifted',
          )}
          data-clip-id={clip.id}
          data-source={clip.kind === 'audio' ? soundSourceOf(clip) : undefined}
          onContextMenu={(event) => {
            if (gesturing) event.preventDefault()
            else if (!selected) onSelect(clip.id, false, false)
          }}
          ref={rootRef}
          role="group"
          style={{
            left: msToPx(timing.start, pps),
            width: Math.max(2, msToPx(timing.duration, pps) - 2),
          }}
        >
          <ClipTip
            quiet={gesturing || preview !== undefined}
            tip={
              clip.kind !== 'host'
                ? undefined
                : text === undefined
                  ? clip.label
                  : `${clip.label} · ${text}`
            }
          >
            <button
              aria-label={`选中：${name}`}
              aria-pressed={selected}
              className="wf-clip-body ui-focus"
              onClick={(event) => {
                if (!clickAfterDrag.take()) onSelect(clip.id, togglesSelection(event), true)
              }}
              // 切开工具下不能裁剪（`trimmable` 为假），点击归剃刀，双击也不打开「属性」
              onDoubleClick={trimmable ? () => onInspect(clip.id) : undefined}
              onPointerCancel={finish}
              onPointerDown={(event) => press(event, 'move')}
              onPointerMove={drag}
              onPointerUp={release}
              type="button"
            >
              <ClipContent
                badge={badge}
                blank={blank}
                clip={clip}
                dub={dub}
                cover={cover}
                keyframes={saved !== null && !silent}
                peaks={peaks}
                timing={timing}
                wave={wave}
                waveRef={waveRef}
                withSound={withSound}
              />
            </button>
          </ClipTip>
          {media === null || envelopePoints === null ? null : (
            <ClipEnvelope
              clipRef={rootRef}
              durationSec={durationSec}
              editable={selected && trimmable}
              onCommit={(points) => onEnvelope(clip.id, points)}
              onDraft={setEnvelopeDraft}
              onGesture={onGesture}
              points={envelopePoints}
              saved={saved ?? NO_POINTS}
              waveRef={waveRef}
            />
          )}
          {clip.kind === 'audio' && beatGrid !== undefined ? (
            <BeatMarks
              beats={shownBeats(clipBeats({ ...clip, ...timing }, beatGrid), pps)}
              pps={pps}
              startMs={timing.start}
            />
          ) : null}
          {selected && trimmable
            ? (['start', 'end'] as const).map((edge) => {
                const bounds = trimRange(clip, groupFor(edge), edge)
                const edgeMs = edgeAt(timing, edge)
                return (
                  <TrimHandle
                    bounds={{ min: bounds.min / 1000, max: bounds.max / 1000 }}
                    edge={edge}
                    key={edge}
                    onKeyDown={(event) => nudge(event, edge)}
                    onPointerCancel={finish}
                    onPointerDown={pressEdge}
                    onPointerMove={drag}
                    onPointerUp={release}
                    pressed={preview?.kind === edge}
                    style={{ left: edge === 'start' ? 0 : '100%' }}
                    value={edgeMs / 1000}
                    valueText={`${seconds(edgeMs)} 秒`}
                  />
                )
              })
            : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuSurface
        aria-label={clip.label}
        className="wf-menu"
        onCloseAutoFocus={(event) => {
          // 菜单里删掉了这个片段：焦点要回去的地方没了，交还编辑器的根节点，快捷键照常
          if (rootRef.current !== null) return
          event.preventDefault()
          editorRoot?.focus()
        }}
      >
        {menu}
      </ContextMenuSurface>
    </ContextMenuRoot>
  )
}

/**
 * 行头最右边的开关：把这一行的片段一起隐藏或显示回来。画面区的行和字幕那一行画成眼睛；声音区的行画成喇叭，
 * 隐藏就是静音。`name` 是这一行的行名。
 */
function RowToggle({
  name,
  zone,
  hidden,
  onHide,
}: {
  name: string
  zone: Zone
  hidden: boolean
  onHide: (hidden: boolean) => void
}) {
  const sound = zone === 'audio'
  const [hide, show] = sound ? ['静音', '取消静音'] : ['隐藏', '显示']
  return (
    <button
      aria-label={`${hidden ? show : hide}${name}`}
      aria-pressed={!hidden}
      className="wf-head-eye ui-state ui-focus"
      onClick={() => onHide(!hidden)}
      title={`${hidden ? show : hide}该行`}
      type="button"
    >
      <Icon
        decorative
        name={
          sound
            ? hidden
              ? 'final-cut-sound-off'
              : 'final-cut-sound-on'
            : hidden
              ? 'final-cut-hidden'
              : 'final-cut-visible'
        }
        size="sm"
      />
    </button>
  )
}

/** 轨道行头图标映射（配音与原声共用人声图标），颜色由样式表按 `data-kind` 区分。 */
const ROW_ICONS: Readonly<Record<RowKind, IconName>> = {
  visual: 'final-cut-shots',
  caption: 'final-cut-captions',
  dub: 'final-cut-voice',
  original: 'final-cut-voice',
  music: 'final-cut-music',
}

/**
 * 轨道行头标识：仅渲染轨道类型图标，同类轨道多于一行时在旁附带序号；完整行名（`name`）通过无障碍名称与悬停提示提供。
 */
function RowSign({ kind, name, ordinal }: { kind: RowKind; name: string; ordinal: number | null }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span aria-label={name} className="wf-head-sign" role="img">
          <Icon decorative name={ROW_ICONS[kind]} size="md" />
          {ordinal === null ? null : <span className="wf-head-ordinal">{ordinal}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="right">
        {name}
      </TooltipContent>
    </TooltipRoot>
  )
}

const keyOf = (row: RowKey) => `${row.zone}-${row.track}`

/** 时间线播放头竖线：直接订阅播放头实时时钟，播放期间逐帧重绘自身。 */
function FilmPlayhead({
  clock,
  totalMs,
  pps,
  dragging,
}: {
  clock: PlayheadClock
  totalMs: number
  pps: number
  dragging: boolean
}) {
  const ms = usePlayheadClock(clock)
  return (
    <TimelinePlayhead dragging={dragging} style={{ left: msToPx(Math.min(ms, totalMs), pps) }} />
  )
}

/**
 * 悬停游标：指针在时间尺和各行上移动（没按着键）时，一条细虚线跟着它往下穿过各行，时间尺上一个小气泡写这个位置的
 * 时间（写法同播放条的时间码）；切开工具下（`razor`）画成实线切分线。只是显示：不定位、不挡点选和拖动。
 * `place` 把指针下的时间换成画在哪（开着吸附时吸上去；切开工具下就是会切开的地方），不画时答 null；`quiet`
 * 时（拖片段、框选、拖播放头）不画。自己听时间区的指针事件、自己记位置，指针动时只重画它自己。
 */
function Skimmer({
  contentRef,
  pps,
  razor,
  quiet,
  place,
}: {
  contentRef: RefObject<HTMLDivElement | null>
  pps: number
  razor: boolean
  quiet: boolean
  place: (ms: number) => number | null
}) {
  const [at, setAt] = useState<number | null>(null)
  const follow = useEffectEvent((event: globalThis.PointerEvent) => {
    const content = contentRef.current
    // 按着键是在拖东西（片段、播放头、时间尺、框选）；触摸没有悬停
    if (content === null || event.buttons !== 0 || event.pointerType === 'touch') setAt(null)
    else setAt(place(pxToMs(event.clientX - content.getBoundingClientRect().left, pps)))
  })
  useEffect(() => {
    const content = contentRef.current
    if (content === null) return
    const hide = () => setAt(null)
    const move = (event: globalThis.PointerEvent) => follow(event)
    content.addEventListener('pointermove', move)
    content.addEventListener('pointerdown', hide)
    content.addEventListener('pointerleave', hide)
    return () => {
      content.removeEventListener('pointermove', move)
      content.removeEventListener('pointerdown', hide)
      content.removeEventListener('pointerleave', hide)
    }
  }, [contentRef])
  if (at === null || quiet) return null
  const left = msToPx(at, pps)
  return (
    <>
      <span
        aria-hidden="true"
        className={cn('wf-skimmer', razor && 'is-razor')}
        data-testid="timeline-skimmer"
        style={{ left }}
      />
      <span aria-hidden="true" className="wf-skimmer-time" style={{ left }}>
        {timeLabel(at / 1000)}
      </span>
    </>
  )
}

/**
 * 时间线：final-cut 里的片段按行排开，画面区的行在上、有字幕时中间一行「字幕」、声音区的行在下，最下面是一条
 * 可以新开一行的空行。
 * 片段可以选中一个或几个（在空白处拖出框来框选）、在自己的区里挪动、裁两端；上面是时间尺和播放头。
 */
export function FilmTimeline({
  clips,
  blankCaptions,
  dubLooks,
  dubHint,
  dubbing,
  hostTexts,
  links,
  tool,
  onSplit,
  catalog,
  totalMs,
  playheadMs,
  clock,
  buffered,
  scale,
  ghost,
  selected,
  snap,
  beats,
  sourceMs,
  onSelect,
  onInspect,
  onGesture,
  gesturing,
  scrollRequest,
  onRetime,
  onMove,
  onRestart,
  onEnvelope,
  onHide,
  onHideClip,
  onAttributes,
  onRemove,
  silentSource,
  soundControls,
  onSeek,
  onJump,
  onViewportWidth,
  handleRef,
}: FilmTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headsRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const rulerBarRef = useRef<HTMLDivElement>(null)
  // 拖动片段时吸上的时间点；拖素材进来时吸上的点由 `ghost` 带着
  const [clipGuideMs, setClipGuideMs] = useState<number | null>(null)
  const guideMs = clipGuideMs ?? ghost?.guideMs ?? null
  // 拖着片段要在第几行的位置新开一行；拖素材进来时同样由 `ghost` 带着
  const [clipOpening, setClipOpening] = useState<number | null>(null)
  const opening =
    clipOpening ?? (ghost === null || 'track' in ghost.row ? null : ghost.row.insertAt)
  // 在一行的空处点右键时，两种合拢各自要挪哪些片段
  const [closing, setClosing] = useState<GapClosing>()
  // 成组拖动中跟着动的片段；每个片段只知道自己素材的总长，一起裁到哪里在这一层算
  const [following, setFollowing] = useState<Following | null>(null)
  const peaks = useAudioPeaks(
    useStableValue([...new Set(clips.filter(isMediaClip).map((clip) => clip.src))]),
  )
  const membersOf = (group: ReadonlySet<string>) => clips.filter((clip) => group.has(clip.id))
  const trimRange = (clip: FilmClip, group: ReadonlySet<string>, edge: Edge) => {
    const range = groupTrimRange(membersOf(group), edge, clips, sourceMs)
    const edgeMs = edgeAt(timingOf(clip), edge)
    return { min: edgeMs + range.min, max: edgeMs + range.max }
  }
  const trimTo = (clip: FilmClip, group: ReadonlySet<string>, edge: Edge, edgeMs: number) =>
    groupTrimmed(membersOf(group), edge, edgeMs - edgeAt(timingOf(clip), edge), clips, sourceMs)
  const { pps, contentWidth } = scale
  const snapBeats = timelineBeats(clips, beats, pps)
  const rows = rowsOf(clips)
  // 还没有片段时也留一行（画面区的第 0 行），镜头拖得进来
  const shown = namedRows<Row>(rows.length === 0 ? [{ zone: 'visual', track: 0, clips: [] }] : rows)
  // 要在别的位置新开一行时，最下面那条空行挪到那里去：总高度不变，上面的行不动、下面的行往下让
  const openedAt = opening !== null && opening < rows.length ? opening : null
  // 配音行的引导占在声音区最上面（生成的配音行就在那里），还没有声音区的行时在最后一行下面
  const firstAudio = rows.findIndex((row) => row.zone === 'audio')
  const hintAt =
    dubHint === null || rows.length === 0 ? null : firstAudio === -1 ? rows.length : firstAudio
  // 引导在两行之间时，在它那个位置新开的行由它自己顶上（见 `hintLane`）；在最后一行下面时只是写着字
  const hintTakesOpening = hintAt !== null && hintAt < rows.length
  /** 第 `at` 行的位置要不要另画一条让出来的新行（引导顶上的那一处不另画）。 */
  const openingAt = (at: number) => openedAt === at && !(hintTakesOpening && at === hintAt)

  useLayoutEffect(() => {
    const viewport = scrollRef.current
    const heads = headsRef.current
    if (viewport === null || heads === null) return
    // 行头那一列和时间区在同一个滚动容器里，排时间的宽度要把它去掉
    const report = () =>
      onViewportWidth(
        Math.max(0, viewport.clientWidth - heads.offsetWidth - INSET.left - INSET.right),
      )
    report()
    const observer = new ResizeObserver(report)
    observer.observe(viewport)
    observer.observe(heads)
    return () => observer.disconnect()
  }, [onViewportWidth])

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  /**
   * 指针对着哪里：时间线上的第几行，或者在第几行的位置新开一行。只认轨道区里露出来的部分：
   * 滚到时间尺底下、滚出轨道区的行，指针看不见也落不上去。
   * 两行之间的缝（含第一行上面、最后一行下面）：`between` 为真时算在那里新开一行；
   * 为假时只有第一行上面算新开一行，别的缝归离得近的那一行。
   */
  const aimAt = (clientY: number, between: boolean): Aim | undefined => {
    const viewport = scrollRef.current
    const rulerBar = rulerBarRef.current
    if (viewport === null || rulerBar === null) return undefined
    const top = viewport.getBoundingClientRect().top + viewport.clientTop
    if (clientY < top || clientY > top + viewport.clientHeight) return undefined
    // 配音行的引导：顶着一处新开行的位置时和最下面那条空行一样算（指针在它上面就在那里新开一行），只写着字的不算
    const measured: Lane[] = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>('.wf-lane') ?? []),
    ].flatMap((lane) => {
      const { top, bottom } = lane.getBoundingClientRect()
      const insertAt = lane.dataset['insertAt']
      const hint = lane.dataset['hint'] !== undefined
      if (hint && insertAt === undefined) return []
      return [{ top, bottom, insertAt: insertAt === undefined ? null : Number(insertAt), hint }]
    })
    // 指针在时间尺上：第一行露着（没滚到时间尺底下）就算在最上面新开一行，不然哪一行都不算
    const rulerBottom = rulerBar.getBoundingClientRect().bottom
    if (clientY < rulerBottom) {
      const first = measured.find((lane) => lane.insertAt === null)
      return rows.length > 0 && first !== undefined && first.top >= rulerBottom
        ? { insertAt: 0 }
        : undefined
    }
    const near = (lane: Lane) =>
      clientY >= lane.top - ROW_REACH_PX && clientY <= lane.bottom + ROW_REACH_PX
    // 已经让出来的那一行：指针还在它上面就还是它（引导顶上的那一处没有让，不算）
    const opened = measured.find(
      (lane) => lane.insertAt !== null && lane.insertAt < rows.length && !lane.hint,
    )
    if (opened?.insertAt != null && near(opened)) return { insertAt: opened.insertAt }
    const lanes = opened === undefined ? measured : withoutOpening(measured, opened)
    // 最下面那条空行：指针在它上面就在那里新开一行
    const waiting = lanes.find((lane) => lane.insertAt !== null && near(lane))
    if (waiting?.insertAt != null) return { insertAt: waiting.insertAt }
    const existing = lanes.filter((lane) => lane.insertAt === null)
    const on = existing.findIndex((lane) => clientY >= lane.top && clientY <= lane.bottom)
    if (on !== -1) return { at: on }
    // 还没有片段时只有一条空行，没有可新开的地方
    if (rows.length === 0) return undefined
    // 指针在第几行的上面那道缝里；比最后一行还靠下时只认紧挨着它的那道缝
    const under = existing.findIndex((lane) => clientY < lane.top)
    const seam = under === -1 ? existing.length : under
    const above = existing[seam - 1]
    const below = existing[seam]
    if (below === undefined && (above === undefined || clientY > above.bottom + 2 * ROW_REACH_PX))
      return undefined
    if (between || above === undefined) return { insertAt: seam }
    return below === undefined || clientY - above.bottom <= below.top - clientY
      ? { at: seam - 1 }
      : { at: seam }
  }

  /** `zone` 区的片段对着这个高度时落在哪一行：片段只待在自己的区里。 */
  const rowAt = (clientY: number, between: boolean, zone: Zone): RowTarget | undefined => {
    const aim = aimAt(clientY, between)
    if (aim === undefined) return undefined
    // 还没有片段时只有画面区那一条空行
    if (rows.length === 0) return { zone: 'visual', track: 0 }
    return targetIn(rows, aim, zone)
  }

  useEffect(() => {
    handleRef.current = {
      locate: (clientX, clientY, zone) => {
        const viewport = scrollRef.current
        const heads = headsRef.current
        if (viewport === null || heads === null) return null
        const right =
          viewport.getBoundingClientRect().left + viewport.clientLeft + viewport.clientWidth
        if (clientX < heads.getBoundingClientRect().right || clientX > right) return null
        const row = rowAt(clientY, zone === 'audio', zone)
        return row === undefined ? null : { row, timeMs: Math.max(0, timeAt(clientX)) }
      },
      scrollLeft: () => scrollRef.current?.scrollLeft ?? 0,
      reveal: (id) =>
        [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-clip-id]') ?? [])]
          .find((element) => element.dataset['clipId'] === id)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    }
    return () => {
      handleRef.current = null
    }
  })

  /** 拖着的素材会落在 `row` 这一行时，画出它会占的位置；不落在这一行是 null。 */
  const dropGhost = (row: RowTarget) =>
    ghost !== null && sameRow(ghost.row, row) ? (
      <span
        aria-hidden="true"
        className="wf-drop-ghost"
        data-testid="drop-ghost"
        style={{
          left: msToPx(ghost.start, pps),
          width: Math.max(2, msToPx(ghost.duration, pps) - 2),
        }}
      />
    ) : null

  /** 拖着的素材会落进在第 `insertAt` 行的位置新开的那一行时，画出它会占的位置。 */
  const newRowGhost = (insertAt: number) =>
    ghost !== null && 'insertAt' in ghost.row && ghost.row.insertAt === insertAt
      ? dropGhost(ghost.row)
      : null

  // 点在片段上（那里出片段的菜单）、点在弹出的菜单上（沿组件树传上来）、正在拖动或框选，
  // 或者这一行没有可合拢的空档：不开菜单
  const openGapMenu = (event: MouseEvent<HTMLElement>, row: RowKey) => {
    const { target } = event
    const inGap =
      !gesturing &&
      target instanceof Element &&
      event.currentTarget.contains(target) &&
      target.closest('[data-clip-id]') === null
    const next = inGap ? gapClosing(clips, row, timeAt(event.clientX)) : undefined
    if (next === undefined || (next.one.size === 0 && next.all.size === 0)) {
      event.preventDefault()
      return
    }
    setClosing(next)
  }

  // 修饰键（Shift / ⌘ / Ctrl）点击切换多选，普通点击单选；
  // 普通单选且播放头位于片段外时自动将播放头移入片段（拖拽落位、右键选中及多选切换不移动播放头）
  const pick = (id: string, toggle: boolean, clicked: boolean) => {
    if (!toggle) {
      onSelect(new Set([id]))
      const clip = clips.find((each) => each.id === id)
      // 按点击瞬间播放头竖线的精确时刻判定（播放期间 state 层的 playheadMs 最多滞后约 0.1 秒）
      const into = clicked && clip !== undefined ? playheadInto(clock.get(), clip) : null
      if (into !== null) onJump(into)
      return
    }
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelect(next)
  }

  // 缩放以后：等新的宽度排好再横向滚过去，不然会被原来的宽度挡住
  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (scrollRequest !== null && viewport !== null) viewport.scrollLeft = scrollRequest.left
  }, [scrollRequest])

  const framingRef = useRef<Framing | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const shownSelection = marquee?.ids ?? selected

  const pointIn = (clientX: number, clientY: number) => {
    const origin = contentRef.current?.getBoundingClientRect()
    return { x: clientX - (origin?.left ?? 0), y: clientY - (origin?.top ?? 0) }
  }

  const framed = (framing: Framing, event: PointerEvent<HTMLElement>): Marquee => {
    const box = boxBetween(framing.origin, pointIn(event.clientX, event.clientY))
    const found = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>('[data-clip-id]') ?? []),
    ].map((element) => {
      const { left, top, width, height } = element.getBoundingClientRect()
      const at = pointIn(left, top)
      return { id: element.dataset['clipId'] ?? '', box: { left: at.x, top: at.y, width, height } }
    })
    return {
      box,
      ids: marqueeSelection(found, box, framing.base, marqueeMode(framing.adding, event)),
    }
  }

  const dropFraming = () => {
    if (framingRef.current === null && marquee === null) return
    framingRef.current = null
    setMarquee(null)
    onGesture(false)
  }
  // 框选中途按 Esc：只取消这次框选，原来的选中不变
  useEditorEscape(marquee !== null, dropFraming)

  const razor = tool === 'razor'
  // 换成切开工具时把手不画了：焦点原来在把手上的话随它丢到页面上，快捷键就收不到了，交还编辑器的根节点
  const editorRoot = useEditorRoot()
  useLayoutEffect(() => {
    if (razor && document.activeElement === document.body) editorRoot?.focus()
  }, [editorRoot, razor])
  // 片段和空档的右键菜单挂在别处，但它们的事件也会沿着组件树传到这里：只认各行里面的
  const inLanes = (event: { target: EventTarget; currentTarget: HTMLElement }) =>
    event.target instanceof Node && event.currentTarget.contains(event.target)
  /**
   * 剃刀下各行上的左键按下和点击在这里截住，不往片段、把手、框选那里传：按下就在那个时间切开，
   * 点击只吞掉（在片段上按 Enter 也不选中）。右键照常出菜单。
   */
  const razorLanes = {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !inLanes(event)) return
      event.stopPropagation()
      const at = timeAt(event.clientX)
      // 按指针所在的行和时间找片段，不按点中的元素：片段画出来比它的时长窄 2px，点在这道缝上也能切到那一刻的片段
      const lane =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-zone][data-track]')
          : null
      const clip = clips.find(
        (each) =>
          zoneOf(each) === lane?.dataset['zone'] &&
          String(each.track) === lane.dataset['track'] &&
          each.start <= at &&
          at < each.start + each.duration,
      )
      onSplit(
        event.shiftKey
          ? splitAllAt(at, clips, links)
          : clip === undefined
            ? []
            : razorSplit(clip, at, clips, links),
      )
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (inLanes(event)) event.stopPropagation()
    },
  }

  const pressLanes = (event: PointerEvent<HTMLDivElement>) => {
    const { target } = event
    // 行的右键菜单挂在别处，但它的事件也会沿着组件树传到这里
    if (event.button !== 0 || !(target instanceof Element) || !event.currentTarget.contains(target))
      return
    if (target.closest('[data-clip-id]') !== null) return
    const canFrame = event.pointerType !== 'touch'
    if (canFrame) event.currentTarget.setPointerCapture(event.pointerId)
    framingRef.current = {
      pointerId: event.pointerId,
      origin: pointIn(event.clientX, event.clientY),
      adding: event.metaKey || event.ctrlKey,
      base: selected,
      canFrame,
      started: false,
    }
  }

  const dragLanes = (event: PointerEvent<HTMLDivElement>) => {
    const framing = framingRef.current
    if (framing === null || framing.pointerId !== event.pointerId || !framing.canFrame) return
    if (!framing.started) {
      const at = pointIn(event.clientX, event.clientY)
      const moved = Math.max(Math.abs(at.x - framing.origin.x), Math.abs(at.y - framing.origin.y))
      if (moved <= DRAG_THRESHOLD) return
      framing.started = true
      onGesture(true)
    }
    setMarquee(framed(framing, event))
  }

  const releaseLanes = (event: PointerEvent<HTMLDivElement>) => {
    const framing = framingRef.current
    if (framing === null || framing.pointerId !== event.pointerId) return
    releasePointer(event)
    // 没拖就是点了空白处：取消全部选中
    onSelect(framing.started ? framed(framing, event).ids : new Set())
    dropFraming()
  }

  /**
   * 指针拖着播放头或时间尺落在 `ms` 时定位到哪：夹在 final-cut 的长度里，开启吸附时优先吸附至片段端点，其次吸附配乐
   * 节拍（排除播放头自身）。悬停游标的读数也按它，和按下去会定到的地方一样。
   */
  const pointerSeekAt = (ms: number) => {
    const at = Math.max(0, Math.min(totalMs, ms))
    return snap
      ? snapEdgeToBeats(at, snapTargets(clips, null), beatsToSnap(snapBeats, NOTHING), pps)
      : { ms: at, guideMs: null }
  }
  /** 拖拽播放头或时间尺定位至 `ms`（吸附规则见 `pointerSeekAt`，吸上时画吸附线）；键盘定位不经由此处且不触发吸附。 */
  const scrubTo = (ms: number) => {
    const snapped = pointerSeekAt(ms)
    setClipGuideMs(snapped.guideMs)
    onSeek(snapped.ms)
  }
  const endScrub = () => setClipGuideMs(null)

  /**
   * 各行上按左键是不是按在了播放头的竖线上：离画出来的竖线不到 `PLAYHEAD_REACH` 像素，而且不是按在选中的片段上。
   * 选中的片段整个优先（身体、把手、音量曲线都算；把手只画在选中的片段上，曲线也只在选中时能改）：点选后播放头
   * 常常跳到指针下面，再按照样是拖这个片段、双击它。竖线还没排版（量不到高度）时不算；切开工具下竖线不能拖，点击
   * 归剃刀；final-cut 是空的时也不能拖。竖线本身不接收指针，按位置在这里判断，所以右键照常落到下面的片段或空档上。
   */
  const onPlayheadLine = (event: { clientX: number; target: EventTarget }) => {
    if (razor || totalMs <= 0) return false
    const under = clipIdAt(event.target)
    if (under !== undefined && selected.has(under)) return false
    const line = rulerBarRef.current?.querySelector('.timeline-playhead')?.getBoundingClientRect()
    return (
      line !== undefined &&
      line.height > 0 &&
      Math.abs(event.clientX - (line.left + line.width / 2)) <= PLAYHEAD_REACH
    )
  }

  // 按住播放头的竖线拖动定位；指针停在竖线上（不在选中的片段上）时光标是左右拖的样子
  const playheadPressRef = useRef<PlayheadPress | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [overPlayhead, setOverPlayhead] = useState(false)
  const pressPlayhead = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !inLanes(event) || !onPlayheadLine(event)) return
    // 按在竖线上先不给下面的片段、框选，拖开了才拖播放头，没拖开就松手当作点了下面的东西
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    playheadPressRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      clip: clipIdAt(event.target) ?? null,
      started: false,
    }
  }
  /** 按着竖线挪：挪过阈值才开始拖播放头，之后跟着指针定位。答 true（这一下用掉了）。 */
  const dragPlayhead = (event: PointerEvent<HTMLDivElement>) => {
    const press = playheadPressRef.current
    if (press === null || press.pointerId !== event.pointerId) return false
    if (!press.started) {
      const moved = Math.hypot(event.clientX - press.originX, event.clientY - press.originY)
      if (moved <= DRAG_THRESHOLD) return true
      press.started = true
      setScrubbing(true)
    }
    scrubTo(timeAt(event.clientX))
    return true
  }
  /**
   * 松开按着竖线的这一下：拖过的收起；没拖开的当作点了下面的东西，片段照点选的规则选中（Shift、⌘、Ctrl 照常是
   * 加减选中），空白处照点空白处取消选中。答 true（这一下用掉了）。
   */
  const releasePlayhead = (event: PointerEvent<HTMLDivElement>) => {
    const press = playheadPressRef.current
    if (press === null || press.pointerId !== event.pointerId) return false
    playheadPressRef.current = null
    releasePointer(event)
    if (press.started) {
      setScrubbing(false)
      endScrub()
    } else if (press.clip === null) onSelect(new Set())
    else pick(press.clip, togglesSelection(event), true)
    return true
  }
  /** 按着竖线的这一下被取消：拖过的收起，没拖开的什么都不做。答 true（这一下用掉了）。 */
  const cancelPlayhead = (event: PointerEvent<HTMLDivElement>) => {
    const press = playheadPressRef.current
    if (press === null || press.pointerId !== event.pointerId) return false
    playheadPressRef.current = null
    if (press.started) {
      setScrubbing(false)
      endScrub()
    }
    return true
  }
  const hoverPlayhead = (event: PointerEvent<HTMLDivElement>) =>
    setOverPlayhead(
      !gesturing && event.pointerType !== 'touch' && inLanes(event) && onPlayheadLine(event),
    )

  /** 配音行的引导那一行的行头：配音行的图标，没有开关。 */
  const hintHead =
    hintAt === null ? null : (
      <span className="wf-track-head" data-kind="dub">
        <RowSign kind="dub" name="配音" ordinal={null} />
      </span>
    )

  /** 配音行的引导那一行；有片段拖到它上面要在那里新开一行时，它自己换成新开的那一行（不另让出一行）。 */
  const hintLane = (at: number) => {
    const opened = openedAt === at
    return (
      <div
        className={cn('wf-lane is-hint', opened && 'is-new is-opening')}
        data-hint=""
        data-insert-at={hintTakesOpening ? at : undefined}
      >
        {opened ? (
          (newRowGhost(at) ?? <span className="wf-lane-hint">新开一行</span>)
        ) : (
          <span className="wf-lane-hint">{dubHint}</span>
        )}
      </div>
    )
  }

  return (
    <div className="wf-tracks" ref={scrollRef}>
      <div className="wf-track-inner">
        <div className="wf-track-heads" ref={headsRef}>
          <span aria-hidden="true" className="wf-track-corner" />
          {shown.map((row, at) => (
            <Fragment key={keyOf(row)}>
              {at === hintAt ? hintHead : null}
              {openingAt(at) ? (
                <span aria-hidden="true" className="wf-track-head is-opening" />
              ) : null}
              <span className="wf-track-head" data-kind={row.kind} data-zone={row.zone}>
                <RowSign kind={row.kind} name={row.name} ordinal={row.ordinal} />
                {row.clips.length > 0 ? (
                  <RowToggle
                    hidden={rowHidden(clips, row)}
                    name={row.name}
                    onHide={(hidden) => onHide({ zone: row.zone, track: row.track }, hidden)}
                    zone={row.zone}
                  />
                ) : null}
              </span>
            </Fragment>
          ))}
          {hintAt === shown.length ? hintHead : null}
        </div>
        <div
          className="wf-track-content"
          ref={contentRef}
          style={{ width: contentWidth, marginLeft: INSET.left, marginRight: INSET.right }}
        >
          <div className="wf-track-top" ref={rulerBarRef}>
            <TimelineRuler
              buffered={buffered}
              clockAt={(clientX) => timeAt(clientX) / 1000}
              currentTime={playheadMs / 1000}
              disabled={totalMs <= 0}
              onPointerSeek={(clock) => scrubTo(Math.round(clock * 1000))}
              onScrub={() => {}}
              onSeek={(clock) => onSeek(Math.round(clock * 1000))}
              onSeekEnd={endScrub}
              scale={contentWidth / pps}
              tickScale={scale.viewSeconds}
              clockTicks
              hoverGuide={false}
              total={totalMs / 1000}
              viewportRef={scrollRef}
            />
            <FilmPlayhead clock={clock} dragging={scrubbing} pps={pps} totalMs={totalMs} />
            <Skimmer
              contentRef={contentRef}
              place={(ms) =>
                totalMs <= 0
                  ? null
                  : razor
                    ? Math.max(0, Math.min(totalMs, ms))
                    : pointerSeekAt(ms).ms
              }
              pps={pps}
              quiet={gesturing || scrubbing}
              razor={razor}
            />
          </div>
          <div
            className={cn('wf-lanes', razor && 'is-razor')}
            data-on-playhead={overPlayhead || scrubbing ? '' : undefined}
            onPointerCancel={(event) => {
              if (!cancelPlayhead(event)) dropFraming()
            }}
            onPointerDown={pressLanes}
            onPointerDownCapture={pressPlayhead}
            onPointerLeave={() => setOverPlayhead(false)}
            onPointerMove={(event) => {
              hoverPlayhead(event)
              if (!dragPlayhead(event)) dragLanes(event)
            }}
            onPointerUp={(event) => {
              if (!releasePlayhead(event)) releaseLanes(event)
            }}
            {...(razor ? razorLanes : {})}
          >
            {shown.map((row, at) => (
              <Fragment key={keyOf(row)}>
                {at === hintAt ? hintLane(at) : null}
                {openingAt(at) ? (
                  <div aria-hidden="true" className="wf-lane is-new is-opening" data-insert-at={at}>
                    {newRowGhost(at) ?? <span className="wf-lane-hint">新开一行</span>}
                  </div>
                ) : null}
                <ContextMenuRoot>
                  <ContextMenuTrigger asChild>
                    <div
                      aria-label={row.name}
                      className="wf-lane"
                      data-track={row.track}
                      data-zone={row.zone}
                      onContextMenu={(event) => openGapMenu(event, row)}
                      role="group"
                    >
                      {row.clips.map((clip) => (
                        <TimelineClip
                          clip={clip}
                          clips={clips}
                          contentRef={contentRef}
                          cover={clip.kind === 'host' ? thumbnailUrl(catalog, clip.item) : null}
                          text={hostTexts.get(clip.id)}
                          withSound={
                            clip.kind === 'video' && soundPairOf(clip, clips) === undefined
                          }
                          following={following}
                          groupFor={(kind) => editGroup(clip, selected, clips, kind)}
                          badge={
                            soundBadgeOf(clip, clips) ?? mutedBadgeOf(clip) ?? carveBadgeOf(clip)
                          }
                          blank={blankCaptions.has(clip.id)}
                          dub={dubLooks.get(clip.id)}
                          dubbing={dubbing}
                          key={clip.id}
                          onFollow={setFollowing}
                          gesturing={gesturing}
                          menu={
                            <ClipMenuItems
                              clip={clip}
                              clips={clips}
                              controls={soundControls}
                              onAttributes={onAttributes}
                              onHide={onHideClip}
                              onRemove={onRemove}
                              onSplit={onSplit}
                              silent={clip.kind === 'video' && silentSource(clip.src)}
                              sound={soundActionFor([clip], clips, silentSource)}
                              split={playheadSplit([clip], playheadMs, clips, links)}
                            />
                          }
                          onGesture={onGesture}
                          onGuide={setClipGuideMs}
                          onEnvelope={onEnvelope}
                          onMove={onMove}
                          onOpening={setClipOpening}
                          onRetime={onRetime}
                          onSelect={pick}
                          onInspect={onInspect}
                          peaks={
                            isMediaClip(clip)
                              ? (peaks.get(clip.src) ?? { kind: 'loading' })
                              : { kind: 'silent' }
                          }
                          playheadMs={playheadMs}
                          pps={pps}
                          rowAt={rowAt}
                          selected={shownSelection.has(clip.id)}
                          snap={snap}
                          beatGrid={isBeatSource(clip) ? beats.get(clip.src) : undefined}
                          snapBeats={snapBeats}
                          trimmable={!razor}
                          trimRange={trimRange}
                          trimTo={trimTo}
                        />
                      ))}
                      {dropGhost(row)}
                      {clips.length === 0 && ghost === null ? (
                        <span className="wf-lane-hint">
                          将「镜头」页签中的镜头拖到此处可加入轨道
                        </span>
                      ) : null}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuSurface aria-label="空档" className="wf-menu">
                    <ContextMenuItem
                      disabled={closing === undefined || closing.one.size === 0}
                      onSelect={() => {
                        if (closing !== undefined) onRestart(closing.one)
                      }}
                    >
                      合拢此空档
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={closing === undefined || closing.all.size === 0}
                      onSelect={() => {
                        if (closing !== undefined) onRestart(closing.all)
                      }}
                    >
                      合拢该行的所有空档
                    </ContextMenuItem>
                  </ContextMenuSurface>
                </ContextMenuRoot>
              </Fragment>
            ))}
            {hintAt === shown.length ? hintLane(hintAt) : null}
            {clips.length === 0 || (openedAt !== null && openingAt(openedAt)) ? null : (
              <div
                aria-label="新的一行"
                className="wf-lane is-new"
                data-insert-at={rows.length}
                role="group"
              >
                {newRowGhost(rows.length) ?? (
                  <span className="wf-lane-hint">拖到此处可新开一行</span>
                )}
              </div>
            )}
          </div>
          {guideMs === null ? null : (
            <span
              aria-hidden="true"
              className="wf-snap-guide"
              data-testid="snap-guide"
              style={{ left: msToPx(guideMs, pps) }}
            />
          )}
          {marquee === null ? null : (
            <span
              aria-hidden="true"
              className="wf-marquee"
              data-testid="marquee"
              style={marquee.box}
            />
          )}
        </div>
      </div>
    </div>
  )
}
