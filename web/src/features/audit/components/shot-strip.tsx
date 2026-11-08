import { cn } from '@/shared/lib/utils'
import type { ExecutionShot } from '../audit.api'

const MAX_DOTS = 6

const shotText = (shot: ExecutionShot) =>
  `第 ${shot.shot} 镜，成功 ${shot.attempts} 次${shot.oneTake ? '，一次通过' : ''}`

export function ShotStrip({
  shots,
  retryAtLeast,
}: {
  shots: readonly ExecutionShot[]
  retryAtLeast: number
}) {
  if (shots.length === 0) {
    return <p className="text-label text-on-surface-muted">暂无成功生成的镜头</p>
  }
  return (
    <ul aria-label="镜头带" className="flex flex-wrap gap-x-5 gap-y-2">
      {shots.map((shot) => {
        const count = shot.attempts
        const over = count >= retryAtLeast
        const text = shotText(shot)
        return (
          <li
            aria-label={text}
            className="flex items-center gap-1 text-label text-on-surface-muted"
            key={shot.shot}
            title={text}
          >
            <span className="mr-1 tabular-nums">镜 {shot.shot}</span>
            {Array.from({ length: Math.min(count, MAX_DOTS) }, (_, index) => {
              const last = index === Math.min(count, MAX_DOTS) - 1
              return (
                <i
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0 rounded-full bg-chart-ghost',
                    last && (over ? 'bg-error' : 'bg-primary'),
                    last && shot.oneTake && 'outline-[1.5px] outline-offset-2 outline-primary',
                  )}
                  key={index}
                />
              )
            })}
            {count > MAX_DOTS ? (
              <span className="ml-0.5 tabular-nums">+{count - MAX_DOTS}</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
