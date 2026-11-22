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

/** 「设置」弹窗：托盘底上一个头部和「用户」分区，高度固定，成员在白卡里滚动。目前只有「用户」一个分区。 */
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
          {/* 共用弹窗没有导出 Radix 的 Close；弹窗受控，直接收起 */}
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
