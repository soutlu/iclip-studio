import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TabsContent } from '@/shared/ui/tabs'
import { MEMBER_GRID_CLASS, TRAY_SURFACE_CLASS } from './settings-surface'

/**
 * 成员表白卡，是角色筛选分段对应的内容区（`value` 跟当前筛选走）。表头固定，`children` 在表头下面滚动；
 * 窄屏每行自己折成两行，不显示表头。
 */
export function MemberTable({ children, value }: { children: ReactNode; value: string }) {
  return (
    <TabsContent
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-card shadow-[var(--shadow-panel-card),var(--shadow-specular)]"
      value={value}
    >
      <div
        className={cn(
          MEMBER_GRID_CLASS,
          'h-9 shrink-0 border-b border-panel-line text-caption font-medium text-on-surface-faint max-sm:hidden',
        )}
      >
        <span>成员</span>
        <span>角色</span>
        <span>配置组</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </TabsContent>
  )
}

/** 搜索或筛选后没有人；给了 `onClear` 才显示「清除筛选条件」。 */
export function NoMatch({ onClear }: { onClear?: (() => void) | undefined }) {
  return (
    <div className="m-auto flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span
        className={cn(
          TRAY_SURFACE_CLASS,
          'mb-0.5 grid size-10 place-items-center rounded-full text-on-surface-faint',
        )}
      >
        <Icon decorative name="search" size="md" />
      </span>
      <p className="text-body font-medium text-on-surface">没有匹配的成员</p>
      {onClear ? (
        <button
          className="cursor-pointer rounded-xs text-label text-on-surface-variant ui-focus hover:underline"
          onClick={onClear}
          type="button"
        >
          清除筛选条件
        </button>
      ) : null}
    </div>
  )
}
