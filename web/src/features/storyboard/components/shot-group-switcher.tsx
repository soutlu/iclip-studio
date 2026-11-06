import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { IconButton } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { encodeContentId } from '../shot-content'
import { formatSeconds } from '../shot-document'

export type ShotGroupSummary = {
  index: number
  seconds: number
  aspectRatio: string
  thumbnailUrl: string | undefined
  sceneSeconds: readonly number[]
  name: string
}

type ShotGroupSwitcherProps = {
  groups: readonly ShotGroupSummary[]
  position: number
  onGo: (shot: number) => void
}

const STEP_CLASS =
  'size-7 rounded-full text-on-surface-variant aria-disabled:cursor-default aria-disabled:text-disabled-text'

export function ShotGroupSwitcher({ groups, onGo, position }: ShotGroupSwitcherProps) {
  const total = groups.length
  const [open, setOpen] = useState(false)
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const currentRef = useRef<HTMLDivElement | null>(null)
  const go = (next: number) => {
    if (next === 1 || next === total) pillRef.current?.focus()
    onGo(next)
  }
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => currentRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  const stepOnArrow = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = position + (event.key === 'ArrowDown' ? 1 : -1)
    if (next >= 1 && next <= total) go(next)
  }
  const totalSeconds = groups.reduce((sum, group) => sum + group.seconds, 0)
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
            {groups.map((group) => (
              <MenuRadioItem
                className="shot-group-menu-row"
                key={group.index}
                ref={group.index === position ? currentRef : undefined}
                textValue={`第 ${group.index} 组 ${group.name}`}
                value={String(group.index)}
              >
                <ShotGroupRow group={group} />
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

function ShotGroupRow({ group }: { group: ShotGroupSummary }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="shot-group-menu-thumb"
        style={{ aspectRatio: aspectValueOf(group.aspectRatio) }}
      >
        {group.thumbnailUrl === undefined ? (
          <span>无图</span>
        ) : (
          <img alt="" draggable={false} src={group.thumbnailUrl} />
        )}
      </span>
      <span className="shot-group-menu-copy">
        <span className="shot-group-menu-title">
          <strong>第 {group.index} 组</strong>
          <span>
            {formatSeconds(group.seconds)} 秒 · {group.sceneSeconds.length} 个镜头
          </span>
        </span>
        <span aria-hidden="true" className="shot-group-menu-strip">
          {group.sceneSeconds.map((seconds, scene) => (
            <i
              key={encodeContentId({ kind: 'scene', scene: scene + 1 })}
              style={{ flexGrow: Math.max(seconds, 0) }}
            />
          ))}
        </span>
        <span className="shot-group-menu-name">{group.name}</span>
      </span>
    </>
  )
}
