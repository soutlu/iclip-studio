import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

/** 一次试连或测试模型的结果。 */
export type Test =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; elapsedMs: number }
  | { kind: 'failed'; reason: string }

/**
 * 试连或测试的结果：通了是绿点加耗时，没通是红点加原因，进行中转圈。`action` 是动作名（试连、测试），
 * 写进进行中的文字与圆点的可访问名。
 */
export function TestStatus({
  action,
  className,
  test,
}: {
  action: string
  test: Test
  className?: string
}) {
  return (
    <span
      aria-live="polite"
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-label text-on-surface-variant tabular-nums',
        className,
      )}
      role="status"
    >
      {test.kind === 'testing' ? (
        <>
          <Icon className="animate-spin" decorative name="loading" size="sm" />
          正在{action}
        </>
      ) : test.kind === 'ok' ? (
        <>
          <span
            aria-label={`${action}通过`}
            className="size-1.5 shrink-0 rounded-full bg-primary"
            role="img"
          />
          {test.elapsedMs} ms
        </>
      ) : test.kind === 'failed' ? (
        <>
          <span
            aria-label={`${action}没通过`}
            className="size-1.5 shrink-0 rounded-full bg-error"
            role="img"
          />
          <span className="min-w-0 text-error">{test.reason}</span>
        </>
      ) : null}
    </span>
  )
}
