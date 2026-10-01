/** 顶栏的镜头组切换胶囊「‹ 镜头组 1 / 3 ▾ ›」：两侧切上一组、下一组，点中间在胶囊下方展开镜头组列表，点一行切到那一组。
 * 上一组、下一组、列表与 ↑↓ 键走同一条换组路径（`onGo`）。到头的一侧置灰而不隐藏，胶囊宽度不随换组跳动；
 * 按到头时那个按钮随即禁用，焦点先交给中间的按钮，仍留在工作台里，↑↓ 照样能切。 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { IconButton } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { encodeContentId } from '../shot-content'
import { formatSeconds, shotName, type Shot } from '../shot-document'

type ShotGroupSwitcherProps = {
  shots: readonly Shot[]
  /** 分镜画幅，列表缩略图按它的比例。 */
  aspectRatio: string
  /** 当前组在全部组里排第几，从 1 起。 */
  position: number
  /** 切到第几组（从 1 起）。 */
  onGo: (shot: number) => void
}

const STEP_CLASS =
  'size-7 rounded-full text-on-surface-variant disabled:cursor-default disabled:text-disabled-text'

export function ShotGroupSwitcher({ aspectRatio, onGo, position, shots }: ShotGroupSwitcherProps) {
  const total = shots.length
  const [open, setOpen] = useState(false)
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const currentRef = useRef<HTMLDivElement | null>(null)
  const go = (next: number) => {
    if (next === 1 || next === total) pillRef.current?.focus()
    onGo(next)
  }
  // 菜单打开时 Radix 先把焦点放在菜单面上（键盘打开再挪到第一行），这里随后改落到当前组，滚动跟着把它带进可视区。
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => currentRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  // 菜单按钮惯例里 ↓ 展开菜单；这颗胶囊例外，↑↓ 仍与工作台里别处一样切组，展开交给点击、Enter 与空格。
  const stepOnArrow = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = position + (event.key === 'ArrowDown' ? 1 : -1)
    if (next >= 1 && next <= total) go(next)
  }
  const totalSeconds = shots.reduce((sum, shot) => sum + shot.seconds, 0)
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
      <MenuRoot onOpenChange={setOpen} open={open}>
        <MenuTrigger asChild>
          {/* 列表展开时组号浮起一层，和下方的列表连成一体。 */}
          <button
            aria-label={`镜头组 ${position} / ${total}，展开镜头组列表`}
            className="inline-flex h-7 ui-state cursor-pointer items-center gap-1 rounded-full px-2 text-body-sm text-on-surface tabular-nums ui-focus data-[state=open]:bg-top-layer data-[state=open]:shadow-[var(--shadow-1)]"
            onKeyDown={stepOnArrow}
            ref={pillRef}
            title="镜头组列表"
            type="button"
          >
            <span className="font-semibold">镜头组 {position}</span>
            <span className="text-on-surface-faint">/ {total}</span>
            <Icon decorative name="expand" size="xs" />
          </button>
        </MenuTrigger>
        <MenuSurface
          align="end"
          aria-label="镜头组列表"
          // Radix 默认用触发按钮命名菜单，那是带组号的长名；清掉它，用上面的短名。
          aria-labelledby={undefined}
          className="shot-group-menu"
          collisionPadding={16}
          sideOffset={6}
        >
          <p className="shot-group-menu-header">
            {total} 组 · 共 {formatSeconds(totalSeconds)} 秒
          </p>
          <MenuRadioGroup
            className="shot-group-menu-list"
            onValueChange={(value) => onGo(Number(value))}
            value={String(position)}
          >
            {shots.map((shot) => (
              <MenuRadioItem
                className="shot-group-menu-row"
                key={shot.index}
                ref={shot.index === position ? currentRef : undefined}
                textValue={`第 ${shot.index} 组 ${shotName(shot)}`}
                value={String(shot.index)}
              >
                <ShotGroupRow aspectRatio={aspectRatio} shot={shot} />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSurface>
      </MenuRoot>
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

type ShotGroupRowProps = {
  shot: Shot
  aspectRatio: string
}

/** 列表里的一行：首帧缩略图、组号与时长、按各镜头时长分段的细条、一行描述。 */
function ShotGroupRow({ aspectRatio, shot }: ShotGroupRowProps) {
  // 首帧取第一个镜头引用的第一张图，没引用就用第一张。
  const frame =
    shot.prompt.timeline[0]?.image_indexes.find(
      (value) => value >= 1 && value <= shot.image_urls.length,
    ) ?? 1
  const url = shot.image_urls[frame - 1]
  return (
    <>
      <span
        aria-hidden="true"
        className="shot-group-menu-thumb"
        style={{ aspectRatio: aspectValueOf(aspectRatio) }}
      >
        {url === undefined ? <span>无图</span> : <img alt="" draggable={false} src={url} />}
      </span>
      <span className="shot-group-menu-copy">
        <span className="shot-group-menu-title">
          <strong>第 {shot.index} 组</strong>
          <span>
            {formatSeconds(shot.seconds)} 秒 · {shot.prompt.timeline.length} 个镜头
          </span>
        </span>
        <span aria-hidden="true" className="shot-group-menu-strip">
          {shot.prompt.timeline.map((item, scene) => (
            <i
              key={encodeContentId({ kind: 'scene', scene: scene + 1 })}
              style={{ flexGrow: Math.max(item.timestamps[1] - item.timestamps[0], 0) }}
            />
          ))}
        </span>
        <span className="shot-group-menu-name">{shotName(shot)}</span>
      </span>
    </>
  )
}
