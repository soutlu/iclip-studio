import { Fragment, type RefObject } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { FilmClip } from './composition/film'
import { rowHidden, type Row, type RowKey, type RowKind, type Zone } from './placement'
import { keyOf } from './timeline-lanes'

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

/**
 * 时间线左边的行头那一列：和各行一一对齐，每行一个行头（行的图标、有片段时一个隐藏或静音的开关）；
 * 让出来的新行和配音行的引导那一行也占一个行头的位置。
 */
export function TrackHeads({
  headsRef,
  shown,
  clips,
  hintAt,
  openingAt,
  onHide,
}: {
  headsRef: RefObject<HTMLDivElement | null>
  /** 时间线上从上往下排的各行，带着行名（见 `namedRows`）。 */
  shown: readonly (Row & { name: string; kind: RowKind; ordinal: number | null })[]
  clips: readonly FilmClip[]
  /** 配音行的引导那一行在第几行的位置；不用引导时是 null。 */
  hintAt: number | null
  /** 第 `at` 行的位置要不要另画一条让出来的新行。 */
  openingAt: (at: number) => boolean
  /** 把 `row` 这一行的片段一起隐藏或显示回来。 */
  onHide: (row: RowKey, hidden: boolean) => void
}) {
  /** 配音行的引导那一行的行头：配音行的图标，没有开关。 */
  const hintHead =
    hintAt === null ? null : (
      <span className="wf-track-head" data-kind="dub">
        <RowSign kind="dub" name="配音" ordinal={null} />
      </span>
    )

  return (
    <div className="wf-track-heads" ref={headsRef}>
      <span aria-hidden="true" className="wf-track-corner" />
      {shown.map((row, at) => (
        <Fragment key={keyOf(row)}>
          {at === hintAt ? hintHead : null}
          {openingAt(at) ? <span aria-hidden="true" className="wf-track-head is-opening" /> : null}
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
  )
}
