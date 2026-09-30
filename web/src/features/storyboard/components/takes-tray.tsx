/** 成片区：文案列末尾一行横滑的本组出片卡，新的在前。吸附到卡、两端还能滚时渐隐，工作台够宽时带左右箭头；
 * 位置、出血与显隐见 storyboard.css 的「成片区」一节。数据整形在 `takes.ts`，这里只排版和转交选中。 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { takeCardSize, type Take } from '../takes'
import { TakeCard } from './take-card'
import { useScrollFade } from './use-scroll-fade'
import { workbenchControl } from './workbench-control'

type TakeSelection = {
  /** 舞台正在看的那条成片。 */
  selectedId: string | undefined
  onSelect: (jobId: string) => void
}

type TakesTrayProps = TakeSelection & {
  /** 本组成片，见 `takesOfShot`；还在读是 undefined。 */
  takes: readonly Take[] | undefined
  /** 读取失败的原因；有它就只说原因。 */
  error: string | undefined
}

/** 读取中与本组还没出过片时整块不占位；读取失败时说原因。 */
export function TakesTray({ error, takes, ...selection }: TakesTrayProps) {
  if (error !== undefined)
    return (
      <section aria-label="本组成片" className="storyboard-takes">
        <p className="storyboard-takes-head text-error" role="alert">
          {error}
        </p>
      </section>
    )
  if (takes === undefined || takes.length === 0) return null
  return <TakesRail takes={takes} {...selection} />
}

/** 有卡时才挂：滚动行一挂上就开始量宽度与两端。 */
function TakesRail({ onSelect, selectedId, takes }: TakeSelection & { takes: readonly Take[] }) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const { fade, width } = useScrollFade(railRef)
  // 「今天」「昨天」按挂上那一刻算；换组会重挂，跨过零点不重算。
  const [now] = useState(() => new Date())
  // 新出的片排在最前：滚回开头让它露出来。吸附会把行留在原来那张卡上，不滚就看不到新卡。
  const newest = takes[0]?.job.id
  useEffect(() => {
    if (railRef.current !== null) railRef.current.scrollLeft = 0
  }, [newest])
  const page = (direction: -1 | 1) => {
    const rail = railRef.current
    if (rail !== null)
      rail.scrollBy({ behavior: 'smooth', left: direction * rail.clientWidth * 0.8 })
  }
  const control = workbenchControl({ shape: 'icon', size: 'sm' })

  return (
    <section aria-label="本组成片" className="storyboard-takes">
      <div className="storyboard-takes-head">
        <h3>
          本组成片<span className="storyboard-takes-count">{takes.length}</span>
        </h3>
        {/* 放得下就没有箭头；工作台窄于 776 时样式收起，靠滑。 */}
        {fade === 'none' ? null : (
          <div className="storyboard-takes-pager">
            <button
              aria-label="往前看"
              className={control}
              disabled={fade === 'end'}
              onClick={() => page(-1)}
              title="往前看"
              type="button"
            >
              <Icon decorative name="back" size="xs" />
            </button>
            <button
              aria-label="往后看"
              className={control}
              disabled={fade === 'start'}
              onClick={() => page(1)}
              title="往后看"
              type="button"
            >
              <Icon decorative name="next" size="xs" />
            </button>
          </div>
        )}
      </div>
      <div className="storyboard-takes-rail storyboard-scroll-fade" data-fade={fade} ref={railRef}>
        <ul className="storyboard-takes-list">
          {takes.map((take) => (
            <TakeCard
              key={take.job.id}
              now={now}
              onSelect={() => onSelect(take.job.id)}
              selected={take.job.id === selectedId}
              size={takeCardSize(take.aspect, width)}
              take={take}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}
