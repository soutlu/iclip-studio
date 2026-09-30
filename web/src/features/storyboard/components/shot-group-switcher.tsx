/** 顶栏的镜头组切换胶囊「‹ 镜头组 1 / 3 ▾ ›」：两侧切上一组、下一组，点中间打开全部镜头组。
 * 上一组、下一组与 ↑↓ 键走同一条换组路径（`onGo`）。到头的一侧置灰而不隐藏，胶囊宽度不随换组跳动；
 * 按到头时那个按钮随即禁用，焦点先交给中间的按钮，仍留在工作台里，↑↓ 照样能切。 */

import { useRef } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'

type ShotGroupSwitcherProps = {
  /** 当前组在全部组里排第几，从 1 起。 */
  position: number
  total: number
  /** 「全部镜头组」正盖在分镜上，中间按钮标成展开。 */
  expanded: boolean
  /** 切到第几组（从 1 起）。 */
  onGo: (shot: number) => void
  /** 打开全部镜头组；`trigger` 是中间按钮，关掉后焦点回到它。 */
  onOpenAll: (trigger: HTMLElement) => void
}

const STEP_CLASS =
  'size-7 rounded-full text-on-surface-variant disabled:cursor-default disabled:text-disabled-text'

export function ShotGroupSwitcher({
  expanded,
  onGo,
  onOpenAll,
  position,
  total,
}: ShotGroupSwitcherProps) {
  const allRef = useRef<HTMLButtonElement | null>(null)
  const go = (next: number) => {
    if (next === 1 || next === total) allRef.current?.focus()
    onGo(next)
  }
  return (
    <div
      aria-label="切换镜头组"
      className="inline-flex h-8 shrink-0 items-center rounded-full bg-surface-container p-0.5"
      role="group"
    >
      <IconButton
        className={STEP_CLASS}
        disabled={position <= 1}
        label="上一组"
        name="back"
        onClick={() => go(position - 1)}
        size="xs"
      />
      <button
        aria-expanded={expanded}
        aria-label={`镜头组 ${position} / ${total}，打开全部镜头组`}
        className="inline-flex h-7 ui-state cursor-pointer items-center gap-1 rounded-full px-2 text-body-sm text-on-surface tabular-nums ui-focus"
        onClick={(event) => onOpenAll(event.currentTarget)}
        ref={allRef}
        title="全部镜头组"
        type="button"
      >
        <span className="font-semibold">镜头组 {position}</span>
        <span className="text-on-surface-faint">/ {total}</span>
        <Icon decorative name="expand" size="xs" />
      </button>
      <IconButton
        className={STEP_CLASS}
        disabled={position >= total}
        label="下一组"
        name="next"
        onClick={() => go(position + 1)}
        size="xs"
      />
    </div>
  )
}
