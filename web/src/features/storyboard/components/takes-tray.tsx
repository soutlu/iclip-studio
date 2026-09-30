/** 成片区：文案列末尾一行横滑的本组出片卡，新的在前。吸附到卡、两端还能滚时渐隐，工作台够宽时带左右箭头；
 * 位置、出血与显隐见 storyboard.css 的「成片区」一节。数据整形在 `takes.ts`，这里只排版和转交操作。 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import type { LightboxMedia } from '@/shared/ui/media-lightbox'
import type { Shot } from '../shot-document'
import type { GenerationJob } from '../storyboard.api'
import { takeCardSize, takesOfShot, type Take } from '../takes'
import { TakeCard } from './take-card'
import { useScrollFade } from './use-scroll-fade'
import { workbenchControl } from './workbench-control'

type TakeActions = {
  onPreview: (media: LightboxMedia) => void
  /** 只读时不给：卡上没有剪刀。 */
  onEditVideo?: ((job: GenerationJob) => void) | undefined
  /** 只读时不给：卡上没有回填。 */
  onRefill?: ((prompt: Shot['prompt']) => void) | undefined
}

type TakesTrayProps = TakeActions & {
  /** 本对话全部视频记录；还在读是 undefined。 */
  jobs: readonly GenerationJob[] | undefined
  /** 读取失败的原因；有它就只说原因。 */
  error: string | undefined
  shotIndex: number
  /** 分镜画幅，请求里没记画幅的卡按它画。 */
  aspectRatio: string
}

/** 读取中与本组还没出过片时整块不占位；读取失败时说原因。 */
export function TakesTray({ aspectRatio, error, jobs, shotIndex, ...actions }: TakesTrayProps) {
  if (error !== undefined)
    return (
      <section aria-label="本组成片" className="storyboard-takes">
        <p className="storyboard-takes-head text-error" role="alert">
          {error}
        </p>
      </section>
    )
  if (jobs === undefined) return null
  const takes = takesOfShot(jobs, shotIndex, aspectRatio)
  if (takes.length === 0) return null
  return <TakesRail takes={takes} {...actions} />
}

/** 有卡时才挂：滚动行一挂上就开始量宽度与两端。 */
function TakesRail({ onEditVideo, onPreview, onRefill, takes }: TakeActions & { takes: Take[] }) {
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
              onEditVideo={onEditVideo}
              onPlay={(url, poster) =>
                onPreview({ kind: 'video', name: '生成的视频', poster, url })
              }
              onRefill={onRefill}
              size={takeCardSize(take.aspect, width)}
              take={take}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}
