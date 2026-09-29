/** 一段对话的镜头带：每镜一组点，点数即成功生成次数；最后一个点绿，达到反复重试门槛的红，一次通过的加环。 */

import { cn } from '@/shared/lib/utils'
import type { ExecutionShot } from '../audit.api'

const MAX_DOTS = 6

/** 悬停与读屏：「第 2 镜，成功 3 次」，一次通过时加「，一次通过」。 */
const shotText = (shot: ExecutionShot) =>
  `第 ${shot.shot} 镜，成功 ${shot.attempts} 次${shot.oneTake ? '，一次通过' : ''}`

export function ShotStrip({
  shots,
  retryAtLeast,
}: {
  shots: readonly ExecutionShot[]
  /** 单镜成功生成达到这么多次算反复重试，最后一个点标红。 */
  retryAtLeast: number
}) {
  if (shots.length === 0) {
    return <p className="text-label text-on-surface-muted">没有成功生成的镜头</p>
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
              // 点都是成功的，颜色只说这一镜过没过门槛；超过六次时画出来的最后一个点代表整镜上色。
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
