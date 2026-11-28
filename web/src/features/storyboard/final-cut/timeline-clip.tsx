import { useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { PeaksState } from '../editing/media-analysis'
import { TrimHandle } from '../editing/timeline'
import type { Edge } from '../editing/timeline-drag'
import { ContextMenuRoot, ContextMenuSurface, ContextMenuTrigger } from '@/shared/ui/menu'
import { timingOf, type Timing } from './clip-edit'
import { BLANK_CAPTION, ClipContent, type ClipWave } from './clip-content'
import { ClipEnvelope } from './clip-envelope'
import {
  isDetachedAudio,
  isDubClip,
  isMediaClip,
  type AudioClip,
  type FilmClip,
  type MediaClip,
} from './composition/film'
import type { DubLook } from './dub-look'
import { useEditorRoot } from './editor-keys'
import type { RowTarget, Zone } from './placement'
import type { SoundBadge } from './sound-pair'
import { BeatMarks } from './beat-marks'
import { clipBeats, shownBeats, type BeatGrid, type TimelineBeat } from './music-beats'
import { msToPx } from './timeline-scale'
import { togglesSelection } from './timeline-lanes'
import { edgeAt, useClipGesture, type Following, type Gesture } from './use-clip-gesture'
import { clipLevel, volumePointsOf, type EnvelopePoint } from './volume-envelope'

const seconds = (ms: number) => (ms / 1000).toFixed(1)

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

/** 片段不出声：隐藏了（音频片段就是静音，整行静音也是），或者视频片段关了原声。 */
const isSilent = (clip: MediaClip) => clip.hidden || (clip.kind === 'video' && clip.muted)

export type TimelineClipProps = {
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
export function TimelineClip({
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
  const { preview, clickAfterDrag, press, pressEdge, drag, finish, release, nudge } =
    useClipGesture({
      clip,
      clips,
      groupFor,
      pps,
      contentRef,
      rowAt,
      onOpening,
      trimTo,
      snap,
      snapBeats,
      playheadMs,
      onGuide,
      onFollow,
      onGesture,
      onRetime,
      onMove,
      rootRef,
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
