import { useId } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { DialogRoot, DialogSurface, DialogTitle } from '@/shared/ui/dialog'
import { PeopleGlyph } from './people-glyph'
import { RAISE_ON_HOVER_CLASS, RAISED_CLASS, TRAY_SURFACE_CLASS } from './settings-surface'
import { UsersSection } from './users-section'

type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 「设置」弹窗：固定高度托盘容器，包含头部与「用户」分区，成员列表在白色卡片内纵向滚动（当前仅设「用户」分区）。 */
export function SettingsDialog({ onOpenChange, open }: SettingsDialogProps) {
  const sectionLabelId = useId()
  return (
    <DialogRoot onOpenChange={onOpenChange} open={open}>
      <DialogSurface
        aria-describedby={undefined}
        bare
        className={cn(
          TRAY_SURFACE_CLASS,
          'h-[min(560px,84vh)] max-w-[720px] gap-3.5 overflow-hidden rounded-xl p-4 shadow-[var(--shadow-3),0_0_0_1px_var(--color-panel-line),var(--shadow-specular)] max-sm:h-[88vh] max-sm:rounded-b-none',
        )}
      >
        <header className="flex shrink-0 items-center gap-3">
          <span
            className={cn(RAISED_CLASS, 'grid size-9.5 shrink-0 place-items-center rounded-md')}
          >
            <PeopleGlyph
              aria-hidden
              className="size-4.75 [--icon-fill-color:var(--color-tone-slate)]"
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-title font-semibold">设置</DialogTitle>
              <span aria-hidden className="text-label text-on-surface-faint">
                ·
              </span>
              <span className="text-ui font-medium text-on-surface-variant" id={sectionLabelId}>
                用户
              </span>
            </div>
            <p className="truncate text-body-sm text-on-surface-faint">
              为成员设置角色和配置组，修改后立即生效
            </p>
          </div>
          {/* 公共 Dialog 未导出 Radix Close 原语；此处为受控弹窗，直接调用回调关闭 */}
          <IconButton
            className={cn(
              RAISE_ON_HOVER_CLASS,
              'size-8 shrink-0 text-on-surface-variant hover:text-on-surface',
            )}
            label="关闭设置"
            name="close"
            onClick={() => onOpenChange(false)}
            size="sm"
          />
        </header>
        {open ? <UsersSection labelledBy={sectionLabelId} /> : null}
      </DialogSurface>
    </DialogRoot>
  )
}
