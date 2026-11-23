import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useCallback, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { WORKBENCH_BUTTON_CLASS } from '@/shared/workbench'
import type { ContentPane } from './-app-shell-layout'
import { revealClippedFocus } from './-reveal-clipped-focus'

type AppContentPaneProps = {
  pane: ContentPane
  width: number
  minWidth: number
  alignEnd: boolean
  collapsed: boolean
  canReorder: boolean
  /** 两栏之间是否存在调宽把手（分隔线由把手绘制）。 */
  resizable: boolean
  onExpand: () => void
  onReveal: () => void
  /** 工作台收起为竖轨时，用于承载工作台内容的插槽容器回调（见 `WorkbenchLayout.railSlot`）。 */
  railSlotRef?: (node: HTMLElement | null) => void
  children: ReactNode
}

export function AppContentPane({
  pane,
  width,
  minWidth,
  alignEnd,
  collapsed,
  canReorder,
  resizable,
  onExpand,
  onReveal,
  railSlotRef,
  children,
}: AppContentPaneProps) {
  const {
    isDragging,
    listeners,
    setNodeRef: setDragNode,
  } = useDraggable({
    id: pane,
    disabled: !canReorder,
  })
  const { isOver, setNodeRef: setDropNode } = useDroppable({ id: pane, disabled: !canReorder })
  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDragNode(node)
      setDropNode(node)
    },
    [setDragNode, setDropNode],
  )

  return (
    <div
      className={cn(
        'group/content-pane relative h-full min-w-0 shrink-0 overflow-clip',
        isDragging && 'opacity-60',
        isOver && !isDragging && 'ring-1 ring-on-surface ring-inset',
      )}
      data-pane={pane}
      data-testid={`pane-${pane}`}
      onFocusCapture={(event) => {
        if (!collapsed && width < minWidth) revealClippedFocus(event, onReveal)
      }}
      onPointerDown={(event) => {
        const target = event.target
        if (
          !(target instanceof Element) ||
          !target.closest('[data-pane-drag-handle]') ||
          target.closest(
            'button, a, input, textarea, select, [role="tab"], [contenteditable="true"]',
          )
        )
          return
        listeners?.['onPointerDown']?.(event)
      }}
      ref={setNodeRef}
      style={{ width }}
    >
      {!collapsed || width === 0 ? null : pane === 'chat' ? (
        <div className="flex h-13 items-center justify-center" data-pane-drag-handle>
          <IconButton
            data-pane-restore
            label="展开对话"
            name="message"
            onClick={onExpand}
            size="sm"
          />
        </div>
      ) : (
        // 工作台收起后的竖轨：「展开工作台」下方通过插槽渲染常驻页签图标与新建按钮（见 WorkbenchRail）。
        // 并排布局时由调宽把手绘制两栏分隔线；非并排布局下无把手，由竖轨在内侧自行绘制分隔线。
        <div
          className={cn(
            'flex h-full flex-col items-center gap-1.25 bg-surface py-2.5',
            !resizable && (alignEnd ? 'border-l border-panel-line' : 'border-r border-panel-line'),
          )}
          data-pane-drag-handle
        >
          <IconButton
            className={WORKBENCH_BUTTON_CLASS}
            data-pane-restore
            label="展开工作台"
            name="final-cut-panel-open"
            onClick={onExpand}
            size="sm"
          />
          <div className="contents" ref={railSlotRef} />
        </div>
      )}
      <div
        aria-hidden={collapsed}
        className={cn('flex h-full min-h-0 min-w-0 flex-col ui-focus', collapsed && 'hidden')}
        data-pane-body
        style={{
          width: Math.max(width, minWidth),
          marginLeft: alignEnd ? Math.min(0, width - minWidth) : 0,
        }}
        hidden={collapsed}
        inert={collapsed}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  )
}
