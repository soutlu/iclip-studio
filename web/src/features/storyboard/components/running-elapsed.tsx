/** 版本条格子里的「生成中」：细圆环加走表，从提交时刻算起，与工作台素材片卡一致。图片编辑与视频编辑的版本条共用。 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useElapsed } from '@/shared/ui/media-preview'

type RunningElapsedProps = {
  /** 提交时刻（ISO）。 */
  since: string
  /** 需要明确区分提交和生成时，用状态文字代替圆环；保留计时位置。 */
  label?: string | undefined
  /** 圆环的颜色类；不给就随所在格子的文字色。 */
  iconClassName?: string
}

export function RunningElapsed({ since, iconClassName, label }: RunningElapsedProps) {
  const elapsed = useElapsed(since)
  return (
    <>
      {label === undefined ? (
        <Icon
          className={cn('motion-safe:animate-spin', iconClassName)}
          decorative
          name="loading"
          size="sm"
        />
      ) : (
        <span>{label}</span>
      )}
      <span className="tabular-nums">{elapsed}</span>
    </>
  )
}
