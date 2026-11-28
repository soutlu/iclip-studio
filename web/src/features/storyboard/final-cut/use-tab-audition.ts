import { useState } from 'react'
import { useAudition, type AudioCoverTraits } from '@/shared/ui/audition'

/** 试听条上要显示的那条：点试听时记下，列表换了筛选、翻了页也不变。 */
export type AuditionItem = {
  id: string
  url: string
  title: string
  peaks: readonly number[] | null
  /** 封面按它挑插画（同列表里那一行的封面）；不给时按音色、按编号挑。 */
  traits?: AudioCoverTraits | undefined
  /** 条目自己记的时长；没有时传 0，读到音频后按真实时长算。 */
  durationMs: number
}

/**
 * 一个侧栏页签里的试听：整页签只放一条（共用一个 `useAudition`，页签藏起来时停下），
 * `toggle` 同时记下这条给试听条用；`shown` 是试听条该显示的那条（没有当前试听时是 null）。
 */
export function useTabAudition(options: { active: boolean; onError: () => void }) {
  const audition = useAudition(options)
  const [item, setItem] = useState<AuditionItem | null>(null)
  return {
    audition,
    toggle: (next: AuditionItem) => {
      setItem(next)
      audition.toggle(next.id, next.url)
    },
    shown: item !== null && audition.current === item.id ? item : null,
  }
}
