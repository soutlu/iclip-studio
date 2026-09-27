/** 列表页共用的状态块：读取中、读取失败、空列表，以及手动「加载更多」与滚到底自动翻页两种页脚。何时显示由调用方定。 */

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

/** 给了 icon 就在文字前放一个主色图标，如「没有异常」前的对勾。 */
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
  /** 按钮文字，读取中时换成「正在读取…」。 */
  label: string
  isFetching: boolean
  onMore: () => void
  /** 给了 shown 就在左侧写已显示几条；total 未知时只写已显示。 */
  shown?: number | undefined
  total?: number | undefined
}

/** 页脚左侧的计数：没给 shown 就不写，total 未知时只写已显示。 */
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

/** 自动翻页页脚要用到的无限查询状态；直接传 useInfiniteQuery 的返回值。 */
type NextPageQuery = {
  /** 最近一次读到数据的时刻；每变一次都按当下位置重新判断。 */
  dataUpdatedAt: number
  isError: boolean
  isFetching: boolean
  isFetchingNextPage: boolean
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>
}

type NextPageFooterProps = {
  query: NextPageQuery
  /** 页面的滚动容器；页脚进入它可视区下方一屏以内就读下一页。 */
  getScrollElement: () => HTMLElement | null
  /** 给了 shown 就在左侧写已显示几条；total 未知时只写已显示。 */
  shown?: number | undefined
  total?: number | undefined
}

/**
 * 自动翻页页脚：滚到接近底部就读下一页，首屏填不满时接着读，直到填满或读完；右侧（没有计数时居中）是读取状态。
 *
 * 查询读取中或出错时暂停，恢复后按当下位置重新判断；还有没有下一页、翻页失败显示什么，由调用方决定。
 */
export function NextPageFooter({ query, getScrollElement, shown, total }: NextPageFooterProps) {
  const footerRef = useRef<HTMLElement>(null)
  const { dataUpdatedAt, isFetchingNextPage } = query
  const paused = query.isFetching || query.isError
  // 在途时不取消重发：页面另有翻页入口（如资料库详情翻到末尾）前后脚触发时，复用同一个请求。
  const loadNextPage = useEffectEvent(() => void query.fetchNextPage({ cancelRefetch: false }))

  // 相交状态不变就不回调，所以每读到一次数据、每次暂停结束都重建观察器，让它按当下布局再报一次；
  // 只跟暂停不够，一页回来得快时「读取中」那次渲染会被合并掉。
  useEffect(() => {
    const footer = footerRef.current
    if (paused || footer === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNextPage()
      },
      // 根得是滚动容器本身，下边距才会按它的一屏往外扩；用视口当根，页脚会先被容器裁掉。
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
      {/* 读屏只播报已在页面上的 live region 的变化，所以它常驻、只换内容；高度与按钮页脚一致，读取前后不跳。 */}
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
