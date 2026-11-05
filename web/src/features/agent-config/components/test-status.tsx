import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

export type Test =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; elapsedMs: number }
  | { kind: 'failed'; reason: string }

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
