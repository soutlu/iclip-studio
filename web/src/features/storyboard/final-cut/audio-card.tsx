import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { AuditionBar, useAuditionRatio, Waveform, type Audition } from '@/shared/ui/audition'
import type { AuditionItem } from './use-tab-audition'

/** 页签底部贴着的单行试听条（见 `AuditionBar` 的紧凑样子）：占自己的高度，不盖住列表的最后一张卡。 */
export function TabAuditionBar({ audition, item }: { audition: Audition; item: AuditionItem }) {
  return (
    <div className="wf-audition-dock">
      <AuditionBar
        audition={audition}
        compact
        durationMs={item.durationMs}
        onToggle={() => audition.toggle(item.id, item.url)}
        peaks={item.peaks}
        title={item.title}
      />
    </div>
  )
}

type AudioCardTextProps = {
  title: string
  /** 名字旁边的小字（语种、时长）。 */
  meta?: string | undefined
  /** 小字靠右（配乐栏的时长）；不给时紧跟在名字后面（选音卡片的「EN · 0:08」）。 */
  metaAtEnd?: boolean
  /** 名字和属性之间的一行，如波形。 */
  wave?: ReactNode
  /** 名字下面那行属性；空串、不给时不显示。 */
  traits?: string | undefined
  /** 排在最后的东西，如正在试听的进度线。 */
  children?: ReactNode
}

/**
 * 侧栏里音频卡片的文字块：配乐栏的音频行、选音面板的音色卡、人声卡的当前音色行共用同一套写法和样子
 * （名字、小字、波形、属性一行行往下排）。
 */
export function AudioCardText({
  title,
  meta,
  metaAtEnd = false,
  wave,
  traits,
  children,
}: AudioCardTextProps) {
  return (
    <span className="wf-audio-text">
      <span className="wf-audio-name">
        <span className="wf-audio-title" title={title}>
          {title}
        </span>
        {meta === undefined ? null : (
          <span className={cn('wf-audio-meta', metaAtEnd && 'is-end')}>{meta}</span>
        )}
      </span>
      {wave}
      {traits === undefined || traits === '' ? null : (
        <span className="wf-audio-traits">{traits}</span>
      )}
      {children}
    </span>
  )
}

/** 卡片里的波形：正在试听的那条按进度上色（只有它订阅每帧的进度），别的整条淡色；没有峰值时不画。 */
export function AudioCardWave({
  peaks,
  current,
  audition,
  durationMs,
}: {
  peaks: readonly number[] | null
  current: boolean
  audition: Audition
  durationMs: number
}) {
  if (peaks === null) return null
  return current ? (
    <PlayingWave audition={audition} durationMs={durationMs} peaks={peaks} />
  ) : (
    <Waveform className="wf-audio-wave" peaks={peaks} />
  )
}

function PlayingWave({
  peaks,
  audition,
  durationMs,
}: {
  peaks: readonly number[]
  audition: Audition
  durationMs: number
}) {
  const { ratio } = useAuditionRatio(audition, durationMs)
  return <Waveform className="wf-audio-wave" peaks={peaks} progress={ratio} />
}
