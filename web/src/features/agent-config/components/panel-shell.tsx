import { useEffect, useId, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { useEscapeWithin } from './use-escape-within'

type PanelShellProps = {
  title: string
  onClose: () => void
  children: ReactNode
  /** 底栏按钮；不给就是一个「完成」。 */
  footer?: ReactNode
  /** 内容区自己管滚动（编辑器）时传 false。 */
  scroll?: boolean
  /** 标题栏右侧的小件（版本、移除）。 */
  actions?: ReactNode
} & Omit<ComponentPropsWithoutRef<'section'>, 'children' | 'title'>

/**
 * 右侧的配置面板：返回图标 + 标题、内容、底栏。打开时焦点落在标题上，Esc 关闭；
 * 面板里弹出的菜单挂在 body 上，它们的 Esc 只关自己，不连带关面板。
 */
export function PanelShell({
  actions,
  children,
  className,
  footer,
  onClose,
  scroll = true,
  title,
  ...props
}: PanelShellProps) {
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [])
  useEscapeWithin(sectionRef, onClose)
  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      ref={sectionRef}
      {...props}
    >
      <header className="flex h-15 shrink-0 items-center gap-2 border-b border-hairline pr-4 pl-3">
        <IconButton label="返回" name="back" onClick={onClose} size="md" />
        <h2
          className="min-w-0 flex-1 truncate text-title font-semibold text-on-surface focus-visible:outline-0"
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
        >
          {title}
        </h2>
        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        )}
      </header>
      <div
        className={cn(
          '@container flex min-h-0 flex-1 flex-col',
          scroll ? 'overflow-y-auto px-6 pt-5 pb-8' : 'px-6 pt-4',
        )}
      >
        {children}
      </div>
      <footer className="flex h-16 shrink-0 items-center justify-end gap-2 border-t border-hairline px-6">
        {footer ?? (
          <Button onClick={onClose} size="md">
            完成
          </Button>
        )}
      </footer>
    </section>
  )
}
