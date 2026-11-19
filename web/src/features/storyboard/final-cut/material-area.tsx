import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import type { KeyframeStates } from './material-media'
import type { MaterialView } from './material-preview'
import {
  picksSummary,
  withTakePicks,
  type Material,
  type MaterialGroup,
  type MaterialPicks,
  type MaterialTake,
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
  /** 一条原作上的选区改了；`view` 是改完要在素材预览里放的那一段，去掉一段时是 null。 */
  onPicks: (takeId: string, picks: TakePicks, view: MaterialView | null) => void
  onClear: () => void
  onInsert: () => void
  /** 选区被拖出镜头条：带着整组选区跟着指针走；null 是取消了。 */
  onCarry: (point: CarryPoint | null, picks: MaterialPicks) => void
  onDrop: (point: CarryPoint, picks: MaterialPicks) => void
}

/** 「镜头」页签：按镜头组排的原作卡片，可以在几条原作上各选几段；有选区时底下浮一条加入 final-cut 的操作条。 */
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
  onPicks,
  onClear,
  onInsert,
  onCarry,
  onDrop,
}: MaterialAreaProps) {
  const summary = picksSummary(picks)
  return (
    <section aria-label="视频素材区" className="wf-materials">
      {placeholder === undefined && groups.length > 0 ? (
        <p className="wf-materials-hint">可自由跨镜头划选多段 · 拖动金边或选框调节长短与位置</p>
      ) : null}
      <div className="wf-materials-list">
        {placeholder ??
          (groups.length === 0 ? (
            <p className="wf-materials-empty">暂无素材片，出片完成后可在此挑选镜头加入 final-cut</p>
          ) : (
            groups.map((group) => (
              <div
                aria-label={group.label}
                className="wf-material-group"
                key={group.id}
                role="group"
              >
                <div aria-hidden="true" className="wf-material-group-head">
                  {group.label}
                </div>
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
                      onVersion={onVersion}
                      playingMs={previewing ? playingMs : undefined}
                      previewing={previewing}
                      spans={picks.get(take.id)?.spans ?? []}
                      take={take}
                      used={used.get(version.url) ?? []}
                      version={version}
                    />
                  )
                })}
              </div>
            ))
          ))}
      </div>
      {summary.count === 0 ? null : (
        <div className="wf-pick-dock">
          <span className="wf-pick-dock-info">
            <i aria-hidden="true" className="wf-pick-dock-dot" />
            已选 {summary.count} 段 · {(summary.durationMs / 1000).toFixed(1)}s
          </span>
          <button className="wf-chip-btn ui-state ui-focus" onClick={onClear} type="button">
            清空
          </button>
          <button
            className="wf-pick-dock-insert ui-state ui-focus"
            onClick={onInsert}
            type="button"
          >
            <Icon decorative name="final-cut-add" size="xs" />
            加入 final-cut
          </button>
        </div>
      )}
    </section>
  )
}
