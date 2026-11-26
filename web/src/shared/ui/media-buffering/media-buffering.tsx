import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ClapperMascot } from '@/shared/ui/clapper-mascot'

/** 等数据时盖在播放区上的提示；`compact` 用在封面、播放键这种几十像素的小块上。 */
export function MediaBuffering({ compact = false }: { compact?: boolean }) {
  // 场记板动画第一次用要先下载，画出来之前先用转圈顶着，等待提示不能空着
  const [drawn, setDrawn] = useState(false)
  return (
    <div
      aria-label="正在缓冲"
      className="pointer-events-none absolute inset-0 z-(--z-local-2) grid animate-in place-items-center text-on-scrim delay-300 duration-(--dur-m) fill-mode-backwards fade-in"
      role="status"
    >
      <span
        className={cn(
          'grid place-items-center *:col-start-1 *:row-start-1',
          compact ? 'p-1' : 'p-2',
          drawn ? 'rounded-md bg-on-scrim shadow-1' : 'rounded-full bg-scrim/32',
        )}
      >
        <ClapperMascot
          className={cn(compact && 'size-6', !drawn && 'opacity-0')}
          onReady={() => setDrawn(true)}
        />
        {drawn ? null : (
          <Icon className="animate-spin" decorative name="spinner" size={compact ? 'lg' : 'xl'} />
        )}
      </span>
    </div>
  )
}
