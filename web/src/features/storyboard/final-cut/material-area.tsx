import { useId, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { KeyframeStates } from './material-media'
import type { MaterialView } from './material-preview'
import {
  filterTakes,
  picksSummary,
  takeInTrack,
  withTakePicks,
  type Material,
  type MaterialGroup,
  type MaterialPicks,
  type MaterialTake,
  type PickedSpan,
  type TakeFilter,
  type TakePicks,
  type UsedSpan,
} from './materials'
import { TakeCard, type CarryPoint } from './take-card'

type MaterialAreaProps = {
  groups: readonly MaterialGroup[]
  placeholder: ReactNode
  versionOf: (take: MaterialTake) => Material
  onVersion: (takeId: string, jobId: string) => void
  keyframes: KeyframeStates
  picks: MaterialPicks
  /** 素材预览正放着的那一段，没有在放素材时是 null。 */
  view: MaterialView | null
  used: ReadonlyMap<string, readonly UsedSpan[]>
  playingMs: number | undefined
  /** 按入轨筛选和收起的组：页签里的界面状态，编辑器替它记着，切页签回来还在。 */
  filter: TakeFilter
  onFilter: (filter: TakeFilter) => void
  closedGroups: ReadonlySet<string>
  onToggleGroup: (groupId: string) => void
  /** 一条原作上的选区改了；`view` 是改完要在素材预览里放的那一段，去掉一段时是 null。 */
  onPicks: (takeId: string, picks: TakePicks, view: MaterialView | null) => void
  onClear: () => void
  onInsert: () => void
  /** 卡片上的「+」：把一条原作显示着的版本整条加入轨道，落点同底部的「加入轨道」。 */
  onInsertWhole: (picked: PickedSpan) => void
  /** 选区被拖出镜头条：带着整组选区跟着指针走；null 是取消了。 */
  onCarry: (point: CarryPoint | null, picks: MaterialPicks) => void
  onDrop: (point: CarryPoint, picks: MaterialPicks) => void
}

const FILTERS: readonly { value: TakeFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'unused', label: '未入轨' },
  { value: 'used', label: '已入轨' },
]

/** 「镜头」页签：顶上按入轨筛选，按镜头组排的原作卡片可以收起，在几条原作上各选几段；有选区时底下浮一条加入轨道的操作条。 */
export function MaterialArea({
  groups,
  placeholder,
  versionOf,
  onVersion,
  keyframes,
  picks,
  view,
  used,
  playingMs,
  filter,
  onFilter,
  closedGroups,
  onToggleGroup,
  onPicks,
  onClear,
  onInsert,
  onInsertWhole,
  onCarry,
  onDrop,
}: MaterialAreaProps) {
  const summary = picksSummary(picks)
  const shown = filterTakes(groups, filter, used)
  const takeCount = groups.reduce((total, group) => total + group.takes.length, 0)
  const listed = placeholder === undefined && groups.length > 0
  return (
    <section aria-label="视频素材区" className="wf-materials">
      {listed ? (
        <div className="wf-materials-top">
          <div aria-label="素材筛选" className="wf-seg wf-materials-filter" role="group">
            {FILTERS.map((each) => (
              <button
                aria-pressed={filter === each.value}
                className="wf-seg-item ui-state ui-focus"
                key={each.value}
                onClick={() => onFilter(each.value)}
                type="button"
              >
                {each.label}
              </button>
            ))}
          </div>
          <span className="wf-materials-count">
            {groups.length} 组 · {takeCount} 条
          </span>
        </div>
      ) : null}
      <div className="wf-materials-list">
        {placeholder ??
          (groups.length === 0 ? (
            <p className="wf-materials-empty">暂无素材片，出片完成后可在此挑选镜头加入轨道</p>
          ) : shown.length === 0 ? (
            // 只有按入轨筛选时会一条不剩
            <p className="wf-materials-empty">
              {filter === 'used' ? '暂无已入轨的出片' : '暂无未入轨的出片'}
            </p>
          ) : (
            shown.map((group) => (
              <MaterialGroupSection
                closed={closedGroups.has(group.id)}
                group={group}
                key={group.id}
                onToggle={() => onToggleGroup(group.id)}
                used={used}
              >
                {group.takes.map((take) => {
                  const version = versionOf(take)
                  const taken = (spans: TakePicks['spans']) => ({ jobId: version.jobId, spans })
                  const previewing = view?.jobId === version.jobId
                  return (
                    <TakeCard
                      key={take.id}
                      keyframe={keyframes.get(version.url)}
                      onCarry={(point, spans) =>
                        onCarry(point, withTakePicks(picks, take.id, taken(spans)))
                      }
                      onChange={(spans, next) => onPicks(take.id, taken(spans), next)}
                      onDrop={(point, spans) =>
                        onDrop(point, withTakePicks(picks, take.id, taken(spans)))
                      }
                      onInsert={onInsert}
                      onInsertWhole={(span) => onInsertWhole({ material: version, span })}
                      onVersion={onVersion}
                      playingMs={previewing ? playingMs : undefined}
                      previewing={previewing}
                      spans={picks.get(take.id)?.spans ?? []}
                      take={take}
                      used={used}
                      version={version}
                    />
                  )
                })}
              </MaterialGroupSection>
            ))
          ))}
      </div>
      {summary.count === 0 ? null : (
        <div
          aria-label={`已选 ${summary.count} 段 · ${(summary.durationMs / 1000).toFixed(1)}s`}
          className="wf-pick-dock"
          role="group"
        >
          <span aria-hidden="true" className="wf-pick-dock-info">
            <i className="wf-pick-dock-dot" />
            已选 <b>{summary.count}</b> 段 · <b>{(summary.durationMs / 1000).toFixed(1)}s</b>
          </span>
          <button className="wf-chip-btn ui-state ui-focus" onClick={onClear} type="button">
            清空
          </button>
          <button className="wf-pick-dock-insert ui-focus" onClick={onInsert} type="button">
            <Icon decorative name="final-cut-add" size="sm" />
            加入轨道
          </button>
        </div>
      )}
    </section>
  )
}

/** 一个镜头组：组头点一下收起或展开；收起时组头写这组有几条已入轨（照稿子）。 */
function MaterialGroupSection({
  group,
  closed,
  used,
  onToggle,
  children,
}: {
  group: MaterialGroup
  closed: boolean
  used: ReadonlyMap<string, readonly UsedSpan[]>
  onToggle: () => void
  children: ReactNode
}) {
  const bodyId = useId()
  const inTrack = group.takes.filter((take) => takeInTrack(take, used)).length
  return (
    <div
      aria-label={group.label}
      className={cn('wf-material-group', closed && 'is-closed')}
      role="group"
    >
      <button
        aria-controls={bodyId}
        aria-expanded={!closed}
        className="wf-material-group-head ui-state ui-focus"
        onClick={onToggle}
        type="button"
      >
        <span className="wf-material-group-title">{group.label}</span>
        {closed && inTrack > 0 ? (
          <span className="wf-take-in-track">
            <i aria-hidden="true" className="wf-take-dot" />
            已用 {inTrack}
          </span>
        ) : null}
        <span className="wf-material-group-count">{group.takes.length} 条出片</span>
        <Icon decorative name="final-cut-expand" size="xs" />
      </button>
      <div className="wf-material-group-body" hidden={closed} id={bodyId}>
        {children}
      </div>
    </div>
  )
}
