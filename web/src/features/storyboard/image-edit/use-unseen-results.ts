/** 版本条上的「未看」小绿点，以及关窗时交回去标成看过的任务。 */

import { useState } from 'react'
import type { StripEntry } from './edit-history'

type Tracked = {
  /** 本次打开期间见过它处于排队或生成中的任务。 */
  readonly inFlight: ReadonlySet<string>
  /** 点开过、且点开时已经落定（有结果或失败）的任务。 */
  readonly opened: ReadonlySet<string>
}

const withAll = (set: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> =>
  ids.every((id) => set.has(id)) ? set : new Set([...set, ...ids])

/**
 * 未看 = 已完成 ∧ 本次打开期间见过它在途 ∧ 没点开过。
 *
 * 打开前就已完成的不算新：帧上的「有新结果」角标管它们。点开在途的那格不算看过，
 * 要等它落定时仍选中着、或之后再点开，看到的才是结果。
 *
 * @param entries 版本条的条目。
 * @param selected 舞台上正显示的那条（选中的任务不在条里时调用方已落回当前帧）。
 * @returns `isUnseen` 判断某格要不要挂绿点；`opened` 是关窗时可以标成看过的任务 id。
 */
export function useUnseenResults(entries: readonly StripEntry[], selected: StripEntry | undefined) {
  const [tracked, setTracked] = useState<Tracked>(() => ({
    inFlight: new Set(),
    opened: new Set(),
  }))

  const pending = entries.flatMap((entry) => (entry.kind === 'pending' ? [entry.job.id] : []))
  const landed =
    (selected?.kind === 'image' || selected?.kind === 'failed') && selected.job !== null
      ? [selected.job.id]
      : []
  const next: Tracked = {
    inFlight: withAll(tracked.inFlight, pending),
    opened: withAll(tracked.opened, landed),
  }
  // 在途与落定都只在渲染时看得到（数据来自轮询），在这里就地记下，不另起一轮 effect。
  if (next.inFlight !== tracked.inFlight || next.opened !== tracked.opened) setTracked(next)

  const isUnseen = (entry: StripEntry) =>
    entry.kind === 'image' &&
    entry.job !== null &&
    next.inFlight.has(entry.job.id) &&
    !next.opened.has(entry.job.id)

  return { isUnseen, opened: next.opened }
}
