import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { takeCardSize, type Take } from '../takes'
import { TakeCard } from './take-card'
import { useScrollFade } from './use-scroll-fade'
import { workbenchControl } from './workbench-control'

type TakeSelection = {
  selectedId: string | undefined
  onSelect: (jobId: string) => void
}

type TakesTrayProps = TakeSelection & {
  takes: readonly Take[] | undefined
  error: string | undefined
}

export function TakesTray({ error, takes, ...selection }: TakesTrayProps) {
  if (error !== undefined)
    return (
      <section aria-label="本组素材片" className="storyboard-takes">
        <p className="storyboard-takes-head text-error" role="alert">
          {error}
        </p>
      </section>
    )
  if (takes === undefined || takes.length === 0) return null
  return <TakesRail takes={takes} {...selection} />
}

function TakesRail({ onSelect, selectedId, takes }: TakeSelection & { takes: readonly Take[] }) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const { fade, width } = useScrollFade(railRef)
  const [now] = useState(() => new Date())
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
    <section aria-label="本组素材片" className="storyboard-takes">
      <div className="storyboard-takes-head">
        <h3>
          本组素材片<span className="storyboard-takes-count">{takes.length}</span>
        </h3>
        {fade === 'none' ? null : (
          <div className="storyboard-takes-pager">
            <button
              aria-label="向前滚动"
              className={control}
              disabled={fade === 'end'}
              onClick={() => page(-1)}
              title="向前滚动"
              type="button"
            >
              <Icon decorative name="back" size="xs" />
            </button>
            <button
              aria-label="向后滚动"
              className={control}
              disabled={fade === 'start'}
              onClick={() => page(1)}
              title="向后滚动"
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
