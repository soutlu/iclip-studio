import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { BlockedReason } from '../components/blocked-reason'
import type { FilmClip } from './composition/film'
import {
  mergeBlocked,
  offsetText,
  resyncPlan,
  type SoundControls,
  type SoundPair,
} from './sound-pair'
import { PropSection, PropSwitch } from './ui/prop-layout'

/** 一个小按钮：`blocked` 非空时置灰但保持可聚焦，点击弹出原因；`tone="soft"` 用于主推荐动作。 */
function PropAction({
  blocked,
  tone,
  onClick,
  children,
}: {
  blocked?: string | undefined
  tone?: 'soft'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <BlockedReason reason={blocked}>
      <button
        aria-disabled={blocked === undefined ? undefined : true}
        className={cn('wf-chip-btn ui-state ui-focus', tone === 'soft' && 'is-soft')}
        onClick={() => {
          if (blocked === undefined) onClick()
        }}
        type="button"
      >
        {children}
      </button>
    </BlockedReason>
  )
}

/** 音画配对的联动开关。 */
function LinkSwitch({
  label,
  pair,
  controls,
}: {
  label: string
  pair: SoundPair
  controls: SoundControls
}) {
  return (
    <PropSwitch
      checked={pair.linked}
      label={label}
      onChange={(linked) => controls.link(pair, linked)}
    />
  )
}

/** 口型对齐按钮：仅在音画错位时呈现；无法对齐时置灰并说明原因。 */
function ResyncAction({
  pair,
  clips,
  controls,
  children,
}: {
  pair: SoundPair
  clips: readonly FilmClip[]
  controls: SoundControls
  children: ReactNode
}) {
  if (pair.offsetMs === 0) return null
  const plan = resyncPlan(pair, clips)
  return (
    <PropAction
      blocked={'refusal' in plan ? plan.refusal : undefined}
      onClick={() => controls.resync(pair)}
      tone="soft"
    >
      {children}
    </PropAction>
  )
}

/** 格式化音画配对同步状态：口型同步、错开时长或倍速不一致。 */
const syncText = (offsetMs: number | null, unit: string) =>
  offsetMs === null
    ? '倍速不同'
    : offsetMs === 0
      ? '口型同步'
      : `错开 ${offsetText(offsetMs, unit)}`

/** 同步状态指示标签：前缀圆点按同步态与错位态区分语义色。 */
function SyncStatus({ pair, children }: { pair: SoundPair; children: ReactNode }) {
  return (
    <span
      className={cn('wf-sound-status', pair.offsetMs !== 0 && 'is-warning')}
      data-testid="sync-status"
    >
      <i aria-hidden="true" className="wf-sound-dot" />
      {children}
    </span>
  )
}

/**
 * 分离过原声的视频片段：「画面变速」（倍速，与分离原声联动），下面说明原声已移至「原声」行并标出同步状态，提供
 * 「定位分离原声」「对齐口型」（错位时）及「合并」。`rate` 是倍速那一条（见 `RateSlider`）。
 */
export function DetachedSections({
  pair,
  clips,
  controls,
  rate,
}: {
  pair: SoundPair
  clips: readonly FilmClip[]
  controls: SoundControls
  rate: ReactNode
}) {
  const blocked = mergeBlocked(pair)
  return (
    <>
      <PropSection title="画面变速">
        {rate}
        <LinkSwitch controls={controls} label="与分离原声联动" pair={pair} />
      </PropSection>
      <PropSection
        end={<SyncStatus pair={pair}>{syncText(pair.offsetMs, 's')}</SyncStatus>}
        title="原声已分离至「原声」行"
      >
        <div className="wf-sound-actions">
          <PropAction onClick={() => controls.locate(pair.audio.id)}>定位分离原声</PropAction>
          <ResyncAction clips={clips} controls={controls} pair={pair}>
            对齐口型
          </ResyncAction>
          <PropAction
            blocked={blocked}
            onClick={() => controls.run({ kind: 'merge', pair, blocked })}
          >
            合并
          </PropAction>
        </div>
      </PropSection>
    </>
  )
}

/**
 * 分离出来的原声最上面几行：同步状态（同步主色、错开提示色）、「联动」开关，下面「对齐画面」（错位时）与「定位画面」。
 */
export function SyncRows({
  pair,
  clips,
  controls,
}: {
  pair: SoundPair
  clips: readonly FilmClip[]
  controls: SoundControls
}) {
  return (
    <>
      <SyncStatus pair={pair}>与画面{syncText(pair.offsetMs, ' 秒')}</SyncStatus>
      <LinkSwitch controls={controls} label="联动" pair={pair} />
      <div className="wf-sound-actions">
        <ResyncAction clips={clips} controls={controls} pair={pair}>
          对齐画面
        </ResyncAction>
        <PropAction onClick={() => controls.locate(pair.video.id)}>定位画面</PropAction>
      </div>
    </>
  )
}
