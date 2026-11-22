import type { IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import type { CreatableEntry } from './artifact'
import { WORKBENCH_BUTTON_CLASS } from './workbench-button'
import { CreateButton, CreatingMark } from './workbench-create'

type RailItem = { id: string; title: string; icon: IconName }

type WorkbenchRailProps = {
  items: readonly RailItem[]
  creatable: readonly CreatableEntry[]
  creating: string | undefined
  onOpen: (id: string) => void
  onCreate: (entry: CreatableEntry) => void
}

/**
 * 工作台收起成竖条时，排在「展开工作台」下面的内容（放进外框给的竖条插槽，见 `WorkbenchLayout.railSlot`）：
 * 一道细分隔、各常驻页签的图标（点了展开工作台并打开它），最底下是能新建的类型的「+」。
 */
export function WorkbenchRail({
  items,
  creatable,
  creating,
  onOpen,
  onCreate,
}: WorkbenchRailProps) {
  return (
    <>
      <span aria-hidden className="my-0.75 h-px w-4.5 shrink-0 bg-panel-line-strong" />
      {items.map((item) => (
        <IconButton
          className={WORKBENCH_BUTTON_CLASS}
          key={item.id}
          label={item.title}
          name={item.icon}
          onClick={() => onOpen(item.id)}
          size="sm"
        />
      ))}
      {creatable.map((entry, index) =>
        creating === entry.type ? (
          <CreatingMark
            className={cn(index === 0 && 'mt-auto')}
            key={entry.type}
            label={entry.label}
          />
        ) : (
          <CreateButton
            className={cn(index === 0 && 'mt-auto')}
            disabled={creating !== undefined}
            key={entry.type}
            label={`新建 ${entry.label}`}
            onClick={() => onCreate(entry)}
          />
        ),
      )}
    </>
  )
}
