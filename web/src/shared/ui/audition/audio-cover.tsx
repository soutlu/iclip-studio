import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

// 设计系统的 5 个分类色，按条目编号固定挑一种；从浅到深的柔和径向渐变
const TONE_CLASSES = [
  'from-tone-copper/35 to-tone-copper',
  'from-tone-ochre/35 to-tone-ochre',
  'from-tone-slate/35 to-tone-slate',
  'from-tone-teal/35 to-tone-teal',
  'from-tone-umber/35 to-tone-umber',
] as const

const toneClassOf = (id: string) => {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TONE_CLASSES[hash % TONE_CLASSES.length] ?? TONE_CLASSES[0]
}

type AudioCoverProps = {
  /** 条目编号：决定封面色调。 */
  id: string
  title: string
  /** 当前这条：在放（`playing`）或暂停着（`paused`）。 */
  state: 'idle' | 'paused' | 'playing'
  onToggle: () => void
  /** 盖在封面上的东西，如等数据的提示。 */
  children?: ReactNode
}

/**
 * 音频条目的封面，本身就是试听键：44px 圆角方块，悬停露出播放键；正在放时变深色底、几根小音柱在跳。
 */
export function AudioCover({ id, title, state, onToggle, children }: AudioCoverProps) {
  const playing = state === 'playing'
  return (
    <button
      aria-label={playing ? `暂停试听：${title}` : `试听：${title}`}
      aria-pressed={playing}
      className={cn(
        'group/cover relative grid size-11 shrink-0 cursor-pointer place-items-center rounded-md shadow-[var(--shadow-xs)] ui-focus',
        playing
          ? 'bg-inverse-surface text-inverse-on-surface'
          : cn('bg-radial-[at_30%_25%]', toneClassOf(id)),
      )}
      onClick={onToggle}
      type="button"
    >
      {playing ? (
        <span aria-hidden className="audition-eq">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <span
          className={cn(
            'grid size-6 place-items-center rounded-full bg-scrim/32 text-on-scrim opacity-0 group-hover/cover:opacity-100 group-focus-visible/cover:opacity-100',
            state === 'paused' && 'opacity-100',
          )}
        >
          <Icon decorative name="play" size="xs" />
        </span>
      )}
      {children}
    </button>
  )
}

type AuditionButtonProps = {
  label: string
  playing: boolean
  onToggle: () => void
  /** 深色底（试听条上的主键）；不给时浅灰底，放着时才变深色。 */
  ink?: boolean
  className?: string | undefined
  children?: ReactNode
}

/** 圆形的播放 / 暂停键：没有封面的条目（音效）和试听条用它。 */
export function AuditionButton({
  label,
  playing,
  onToggle,
  ink = false,
  className,
  children,
}: AuditionButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={playing}
      className={cn(
        'relative grid size-9 shrink-0 ui-state cursor-pointer place-items-center rounded-full ui-focus',
        ink || playing
          ? 'bg-inverse-surface text-inverse-on-surface'
          : 'bg-surface-container text-on-surface',
        className,
      )}
      onClick={onToggle}
      type="button"
    >
      <Icon decorative name={playing ? 'pause' : 'play'} size="sm" />
      {children}
    </button>
  )
}
