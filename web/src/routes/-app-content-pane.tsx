import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useCallback, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import type { ContentPane } from './-app-shell-layout'
import { revealClippedFocus } from './-reveal-clipped-focus'

type AppContentPaneProps = {
  pane: ContentPane
  width: number
  minWidth: number
  alignEnd: boolean
  collapsed: boolean
  canReorder: boolean
  onExpand: () => void
  onReveal: () => void
  children: ReactNode
}

/** 固定 DOM 顺序保留编辑器与滚动状态；壳以 flex 方向换位，折叠只隐藏正文。 */
export function AppContentPane({
  pane,
  width,
  minWidth,
  alignEnd,
  collapsed,
  canReorder,
  onExpand,
  onReveal,
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
      {collapsed && width > 0 ? (
        <div className="flex h-13 items-center justify-center" data-pane-drag-handle>
          <IconButton
            data-pane-restore
            label={pane === 'chat' ? '展开对话' : '展开工作台'}
            name={pane === 'chat' ? 'message' : 'grid'}
            onClick={onExpand}
            size="sm"
            title={pane === 'chat' ? '展开对话' : '展开工作台'}
          />
        </div>
      ) : null}
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
