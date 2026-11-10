import type { ReactNode } from 'react'

/** 面板里一节的标题：标题下一句灰色说明，右侧可放一个操作。`id` 给所在 section 的 `aria-labelledby` 用。 */
export function SectionHeading({
  action,
  id,
  note,
  title,
}: {
  id: string
  title: string
  note: string
  action?: ReactNode
}) {
  return (
    <div className="mb-1 flex min-h-8 items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-body font-semibold text-on-surface" id={id}>
          {title}
        </h3>
        <p className="truncate text-label text-on-surface-faint">{note}</p>
      </div>
      {action === undefined ? null : <div className="-mr-1 flex items-center">{action}</div>}
    </div>
  )
}
