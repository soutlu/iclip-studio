import type { ComponentPropsWithoutRef, ReactNode, RefObject } from 'react'

type LibraryPageShellProps = Omit<ComponentPropsWithoutRef<'main'>, 'className' | 'children'> & {
  label: string
  mainRef: RefObject<HTMLElement | null>
  header: ReactNode
  filters: ReactNode
  children: ReactNode
  attachments?: ReactNode
}

export function LibraryPageShell({
  label,
  mainRef,
  header,
  filters,
  children,
  attachments,
  ...mainProps
}: LibraryPageShellProps) {
  return (
    <main
      {...mainProps}
      aria-label={label}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={mainRef}
    >
      <div className="flex w-full flex-col px-4 pt-12 pb-10 sm:px-(--layout-list-page-gutter) sm:pt-14">
        {header}
        <div className="layer-content sticky top-0 -mx-1 bg-background px-1 py-3">{filters}</div>
        <div className="pt-3">{children}</div>
      </div>
      {attachments}
    </main>
  )
}
