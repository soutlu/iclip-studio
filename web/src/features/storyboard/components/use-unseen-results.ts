/** 版本条上的「未看」小绿点，以及关窗时交回去标成看过的任务。图片编辑与视频编辑的版本条共用。 */

import { useState } from 'react'

type Tracked = {
  /** 本次打开期间见过它处于排队或生成中的任务。 */
  readonly inFlight: ReadonlySet<string>
  /** 点开过、且点开时已经落定（有结果或失败）的任务。 */
  readonly opened: ReadonlySet<string>
}

const withAll = (set: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> =>
  ids.every((id) => set.has(id)) ? set : new Set([...set, ...ids])

/**
 * 未看 = 已完成 ∧ 本次打开期间见过它在途 ∧ 没点开过。「已完成」由调用方按自己的条目判断。
 *
 * 打开前就已完成的不算新：帧上的「有新结果」角标管它们。点开在途的那格不算看过，
 * 要等它落定时仍选中着、或之后再点开，看到的才是结果。
 *
 * @param inFlight 这一轮渲染里还在排队或生成的任务 id。
 * @param landed 舞台上正显示、且已经落定的那条任务 id；正看着的不是某条任务、或它还在途时不传。
 * @returns `isUnseen` 判断某条任务要不要挂绿点；`opened` 是关窗时可以标成看过的任务 id。
 */
export function useUnseenResults(inFlight: readonly string[], landed: string | undefined) {
  const [tracked, setTracked] = useState<Tracked>(() => ({
    inFlight: new Set(),
    opened: new Set(),
  }))

  const next: Tracked = {
    inFlight: withAll(tracked.inFlight, inFlight),
    opened: withAll(tracked.opened, landed === undefined ? [] : [landed]),
  }
  // 在途与落定都只在渲染时看得到（数据来自轮询），在这里就地记下，不另起一轮 effect。
  if (next.inFlight !== tracked.inFlight || next.opened !== tracked.opened) setTracked(next)

  const isUnseen = (id: string) => next.inFlight.has(id) && !next.opened.has(id)

  return { isUnseen, opened: next.opened }
}
