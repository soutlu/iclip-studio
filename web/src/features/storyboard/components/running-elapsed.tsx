/** 版本条格子里的「生成中」：细圆环加走表，从提交时刻算起，与工作台成片卡一致。图片编辑与视频编辑的版本条共用。 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useTakeElapsed } from './use-take-elapsed'

type RunningElapsedProps = {
  /** 提交时刻（ISO）。 */
  since: string
  /** 圆环的颜色类；不给就随所在格子的文字色。 */
  iconClassName?: string
}

export function RunningElapsed({ since, iconClassName }: RunningElapsedProps) {
  const elapsed = useTakeElapsed(since)
  return (
    <>
      <Icon
        className={cn('motion-safe:animate-spin', iconClassName)}
        decorative
        name="loading"
        size="sm"
      />
      <span className="tabular-nums">{elapsed}</span>
    </>
  )
}
