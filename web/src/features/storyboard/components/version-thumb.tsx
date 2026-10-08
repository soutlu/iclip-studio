/** 编辑器版本条的小图格，图片编辑与视频编辑共用；样式见 storyboard.css「编辑器舞台共用」一节。
 * 只管一格的样子，条怎么摆（舞台右缘竖排、窄屏舞台下方横排）由各编辑器自己定。 */

import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { versionThumbSize } from './version-thumb-size'

/** 按画幅给格子定尺寸；不给画幅时用样式里的默认 40×71。 */
const sizeOf = (ratio: string | undefined): CSSProperties | undefined =>
  ratio === undefined ? undefined : versionThumbSize(ratio)

type VersionThumbProps = {
  /** 可访问名与悬停提示。 */
  name: string
  /** 压在小图底部的名字；不给就不压字（状态遮罩自己说明时）。 */
  label?: string | undefined
  selected: boolean
  onClick: () => void
  disabled?: boolean | undefined
  /** 画幅，决定格子的宽高比；不给是竖版 9:16。 */
  ratio?: string | undefined
  /** 有还没看过的新结果：右上角挂小绿点。 */
  unseen?: boolean | undefined
  /** 盖在小图上的状态（生成中、排队、失败），压暗一层再居中摆。 */
  state?: ReactNode
  /** 小图本身：缩略图，或读不出图时的占位。 */
  children: ReactNode
}

/** 一版的小画面：没选的淡一些、小一点，选中的完整亮度加一圈细白环。 */
export function VersionThumb({
  name,
  label,
  selected,
  onClick,
  disabled,
  ratio,
  unseen = false,
  state,
  children,
}: VersionThumbProps) {
  return (
    <button
      aria-label={name}
      aria-pressed={selected}
      className="version-thumb ui-focus"
      disabled={disabled}
      onClick={onClick}
      style={sizeOf(ratio)}
      title={name}
      type="button"
    >
      {children}
      {state === undefined ? null : <span className="version-thumb-state">{state}</span>}
      {unseen ? <span className="version-thumb-dot" /> : null}
      {label === undefined ? null : <span className="version-thumb-label">{label}</span>}
    </button>
  )
}

type VersionTileProps = {
  icon: ReactNode
  /** 图标下面的名字，也是可访问名。 */
  label: string
  /** 悬停提示，补充名字说不全的意思。 */
  title: string
  onClick: () => void
  disabled?: boolean | undefined
  /** 能选中的格子（如「再生成」）给出选中态；只是一个动作的（如「更早」）不给。 */
  selected?: boolean | undefined
  ratio?: string | undefined
  className?: string | undefined
}

/** 条里不是某一版的格子（「更早」「再生成」）：与小图同尺寸的浅色玻璃格，图标居中、名字在下。 */
export function VersionTile({
  icon,
  label,
  title,
  onClick,
  disabled,
  selected,
  ratio,
  className,
}: VersionTileProps) {
  return (
    <button
      aria-pressed={selected}
      className={cn('version-thumb version-thumb-tile ui-focus', className)}
      disabled={disabled}
      onClick={onClick}
      style={sizeOf(ratio)}
      title={title}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
