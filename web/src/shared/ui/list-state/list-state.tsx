import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export function ListPending({ label }: { label: string }) {
  return (
    <p
      className="flex items-center justify-center gap-2 py-16 text-body text-on-surface-variant"
      role="status"
    >
      <Icon className="animate-spin" decorative name="loading" size="sm" />
      {label}
    </p>
  )
}

export function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16" role="alert">
      <p className="text-body text-error">{message}</p>
      <Button leadingIcon="refresh" onClick={onRetry} size="md" variant="outlined">
        重新加载
      </Button>
    </div>
  )
}

export function ListEmpty({ children, icon }: { children: ReactNode; icon?: IconName }) {
  if (icon === undefined) {
    return <p className="py-16 text-center text-body text-on-surface-variant">{children}</p>
  }
  return (
    <p className="flex items-center justify-center gap-2 py-16 text-body text-on-surface-variant">
      <Icon className="text-primary" decorative name={icon} size="sm" />
      {children}
    </p>
  )
}

type LoadMoreFooterProps = {
  label: string
  isFetching: boolean
  onMore: () => void
  shown?: number | undefined
  total?: number | undefined
}

const counterOf = (shown: number | undefined, total: number | undefined) =>
  shown === undefined
    ? null
    : total === undefined
      ? `已显示 ${shown}`
      : `已显示 ${shown} / ${total}`

export function LoadMoreFooter({ label, isFetching, onMore, shown, total }: LoadMoreFooterProps) {
  const counter = counterOf(shown, total)
  return (
    <footer
      className={cn(
        'flex items-center px-3 py-4',
        counter === null
          ? 'justify-center'
          : 'justify-between gap-4 text-body text-on-surface-variant',
      )}
    >
      {counter === null ? null : <span>{counter}</span>}
      <Button disabled={isFetching} leadingIcon="expand" onClick={onMore} size="md" variant="ghost">
        {isFetching ? '正在读取…' : label}
      </Button>
    </footer>
  )
}

type NextPageQuery = {
  dataUpdatedAt: number
  isError: boolean
  isFetching: boolean
  isFetchingNextPage: boolean
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>
}

type NextPageFooterProps = {
  query: NextPageQuery
  getScrollElement: () => HTMLElement | null
  shown?: number | undefined
  total?: number | undefined
}

export function NextPageFooter({ query, getScrollElement, shown, total }: NextPageFooterProps) {
  const footerRef = useRef<HTMLElement>(null)
  const { dataUpdatedAt, isFetchingNextPage } = query
  const paused = query.isFetching || query.isError
  const loadNextPage = useEffectEvent(() => void query.fetchNextPage({ cancelRefetch: false }))

  useEffect(() => {
    const footer = footerRef.current
    if (paused || footer === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNextPage()
      },
      { root: getScrollElement(), rootMargin: '0px 0px 100% 0px' },
    )
    observer.observe(footer)
    return () => observer.disconnect()
  }, [dataUpdatedAt, getScrollElement, paused])

  const counter = counterOf(shown, total)
  return (
    <footer
      className={cn(
        'flex items-center px-3 py-4 text-body text-on-surface-variant',
        counter === null ? 'justify-center' : 'justify-between gap-4',
      )}
      ref={footerRef}
    >
      {counter === null ? null : <span>{counter}</span>}
      <p className="flex h-(--control-height-md) items-center gap-2" role="status">
        {isFetchingNextPage ? (
          <>
            <Icon className="animate-spin" decorative name="loading" size="sm" />
            正在读取…
          </>
        ) : null}
      </p>
    </footer>
  )
}
