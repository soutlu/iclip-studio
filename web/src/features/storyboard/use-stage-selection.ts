import { useState } from 'react'

type StageSelection = { kind: 'content' } | { kind: 'take'; jobId: string; shot: number }

export const useStageSelection = (shot: number) => {
  const [selection, setSelection] = useState<StageSelection>({ kind: 'content' })
  if (selection.kind === 'take' && selection.shot !== shot) setSelection({ kind: 'content' })
  return {
    takeId: selection.kind === 'take' && selection.shot === shot ? selection.jobId : undefined,
    selectTake: (jobId: string) => setSelection({ jobId, kind: 'take', shot }),
    selectContent: () => setSelection({ kind: 'content' }),
  }
}
