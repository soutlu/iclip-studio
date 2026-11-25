import { cn } from '@/shared/lib/utils'

// 底栏高度固定，说明最多三行，放不下时截断，不把右侧按钮挤下去。
const NOTE = 'mr-auto line-clamp-3 min-w-0 text-body-sm'

/** 编辑器底栏左侧的说明：有报错时只显示报错；没有报错时显示状态，`status` 为 `null` 时不显示。 */
export function FooterNote({ notice, status }: { notice: string | null; status: string | null }) {
  if (notice !== null)
    return (
      <p className={cn(NOTE, 'text-error')} role="alert">
        {notice}
      </p>
    )
  if (status === null) return null
  return (
    <p className={cn(NOTE, 'text-on-surface-variant')} role="status">
      {status}
    </p>
  )
}
