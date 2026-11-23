import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TabsContent } from '@/shared/ui/tabs'
import { MEMBER_GRID_CLASS, TRAY_SURFACE_CLASS } from './settings-surface'

/**
 * 成员表白色卡片容器，对应角色筛选分段的 `TabsContent`（`value` 与当前筛选值同步）。
 * 表头固定于顶部，`children` 在下方区域纵向滚动；窄屏下隐藏表头并由各行折为两行展示。
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

/** 成员列表筛选空态；传入 `onClear` 时提供「清除筛选条件」操作。 */
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
      <p className="text-body font-medium text-on-surface">暂无匹配的成员</p>
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
