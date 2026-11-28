import { ContextMenuItem } from '@/shared/ui/menu'
import type { GapClosing } from './clip-edit'

/**
 * 行的空档右键菜单里的两项：合拢点着的这个空档、合拢这一行所有的空档。`closing` 是两种合拢各自要挪的片段
 * （见 `useGapMenu`），没有要挪的那一项不能点；`onRestart` 把这些片段挪到新的起点。
 */
export function GapMenuItems({
  closing,
  onRestart,
}: {
  closing: GapClosing | undefined
  onRestart: (starts: ReadonlyMap<string, number>) => void
}) {
  return (
    <>
      <ContextMenuItem
        disabled={closing === undefined || closing.one.size === 0}
        onSelect={() => {
          if (closing !== undefined) onRestart(closing.one)
        }}
      >
        合拢此空档
      </ContextMenuItem>
      <ContextMenuItem
        disabled={closing === undefined || closing.all.size === 0}
        onSelect={() => {
          if (closing !== undefined) onRestart(closing.all)
        }}
      >
        合拢该行的所有空档
      </ContextMenuItem>
    </>
  )
}
