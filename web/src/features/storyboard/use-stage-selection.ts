/** 工作台上唯一的「选中」：文案段与帧（记在路由里），或本组的某条成片（只在本地）。两者互斥，舞台显示选中的那个。 */

import { useState } from 'react'

type StageSelection = { kind: 'content' } | { kind: 'take'; jobId: string; shot: number }

/** `shot` 是当前组号：换组就回到文案与帧，再切回来也不恢复原来选的成片。 */
export const useStageSelection = (shot: number) => {
  const [selection, setSelection] = useState<StageSelection>({ kind: 'content' })
  // 渲染中按组号收回：React 推荐的「随输入重置状态」写法，不经副作用、不多渲染一帧旧画面。
  if (selection.kind === 'take' && selection.shot !== shot) setSelection({ kind: 'content' })
  return {
    /** 选中的成片记录 id；没选时为 undefined。这条成片已不在列表里时由调用方当作没选。 */
    takeId: selection.kind === 'take' && selection.shot === shot ? selection.jobId : undefined,
    selectTake: (jobId: string) => setSelection({ jobId, kind: 'take', shot }),
    selectContent: () => setSelection({ kind: 'content' }),
  }
}
