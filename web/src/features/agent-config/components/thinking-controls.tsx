import { Slider } from 'radix-ui'
import { useId, useState, type KeyboardEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { THINKING_LEVELS, thinkingLabel, type ThinkingLevel } from '@/shared/ui/thinking-level'
import './thinking-controls.css'

/** 拖动时连续预览，释放后提交最近的有效档位；键盘逐档调节，默认值独立于强度刻度。 */
export function ThinkingFader({
  levels,
  value,
  onChange,
}: {
  levels: readonly ThinkingLevel[]
  value: ThinkingLevel | null
  onChange: (value: ThinkingLevel | null) => void
}) {
  const id = useId()
  const index = value === null ? -1 : levels.indexOf(value)
  const explicit = index >= 0
  const [dragPosition, setDragPosition] = useState<number | null>(null)
  const position = dragPosition ?? Math.max(0, index)
  const previewLevel = dragPosition === null ? value : (levels[Math.round(position)] ?? value)
  const label = previewLevel === null ? '默认' : thinkingLabel(previewLevel)
  const unavailable = value !== null && !explicit
  const disabled = !explicit || levels.length === 1
  const commit = (next: number) => {
    const level = levels[Math.max(0, Math.min(levels.length - 1, Math.round(next)))]
    setDragPosition(null)
    if (level !== undefined && level !== value) onChange(level)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return
    const current = Math.round(position)
    const next = {
      ArrowRight: current + 1,
      ArrowUp: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current - 1,
      PageUp: current + 1,
      PageDown: current - 1,
      Home: 0,
      End: levels.length - 1,
    }[event.key]
    if (next === undefined) return
    // Radix 的细步进用于指针跟手，键盘仍按真实模型档位移动。
    event.preventDefault()
    commit(next)
  }

  return (
    <div className="thinking-fader" role="group" aria-labelledby={id}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-label font-medium text-on-surface-variant" id={id}>
          思考强度
        </span>
        <div className="flex items-center gap-3">
          {levels.length > 0 || unavailable ? (
            <button
              aria-label="恢复默认思考档位"
              className="ui-state cursor-pointer rounded-xs px-1 text-caption text-on-surface-muted ui-focus disabled:cursor-default disabled:opacity-40"
              disabled={value === null}
              onClick={() => onChange(null)}
              type="button"
            >
              恢复默认
            </button>
          ) : null}
          <span className="text-title-sm min-w-8 text-right font-semibold text-on-surface">
            {label}
          </span>
        </div>
      </div>
      {unavailable ? (
        <p className="mt-2 text-caption text-error">当前档位已不可用，请重新选择</p>
      ) : null}
      {levels.length === 0 ? (
        <p className="mt-2 text-caption text-on-surface-muted">
          {unavailable ? '请恢复默认思考档位' : '该模型使用默认思考强度'}
        </p>
      ) : (
        <div className="mt-3 px-4">
          <Slider.Root
            className="thinking-fader-slider"
            data-dragging={dragPosition !== null}
            disabled={disabled}
            max={Math.max(1, levels.length - 1)}
            min={0}
            onKeyDown={onKeyDown}
            onPointerCancel={() => setDragPosition(null)}
            onPointerDown={() => {
              if (!disabled) setDragPosition(Math.max(0, index))
            }}
            onPointerUp={() => setDragPosition(null)}
            onValueChange={([next]) => {
              if (next !== undefined) setDragPosition(next)
            }}
            onValueCommit={([next]) => {
              if (next !== undefined) commit(next)
            }}
            step={0.01}
            value={[position]}
          >
            <Slider.Track className="thinking-fader-track">
              {explicit ? <Slider.Range className="thinking-fader-range" /> : null}
            </Slider.Track>
            <Slider.Thumb
              aria-disabled={disabled}
              aria-label="思考档位"
              aria-valuetext={
                value === null ? '默认（跟随模型）' : unavailable ? `${label}（不可用）` : label
              }
              className={cn('thinking-fader-thumb ui-focus', !explicit && 'opacity-0')}
            >
              <span aria-hidden className="thinking-fader-grip" />
            </Slider.Thumb>
          </Slider.Root>
          <div className="thinking-fader-labels">
            {levels.map((level, position) => (
              <button
                aria-pressed={previewLevel === level}
                className={cn(
                  'thinking-fader-label ui-state cursor-pointer rounded-xs text-caption text-on-surface-muted ui-focus',
                  previewLevel === level && 'font-medium text-primary',
                )}
                key={level}
                onClick={() => {
                  setDragPosition(null)
                  onChange(level)
                }}
                style={{
                  left: `${levels.length === 1 ? 0 : (position / (levels.length - 1)) * 100}%`,
                }}
                type="button"
              >
                {thinkingLabel(level)}
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-caption text-on-surface-muted">
            <span>{value === null ? '跟随模型默认' : '更快'}</span>
            <span>更深入</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** 模型支持的档位是一组独立开关，允许不连续多选，沿用推子的握柄形态。 */
export function ThinkingLevelOptions({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly ThinkingLevel[]
  onChange: (value: ThinkingLevel[]) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div aria-labelledby={id} className="thinking-level-options" role="group">
      <div className="flex items-center justify-between gap-3">
        <span className="text-label font-medium text-on-surface-variant" id={id}>
          思考档位
        </span>
        <span className="text-caption text-on-surface-muted">已启用 {value.length} 档</span>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1">
        {THINKING_LEVELS.map((level) => {
          const selected = value.includes(level)
          return (
            <button
              aria-pressed={selected}
              className="thinking-level-key group min-w-0 ui-state cursor-pointer rounded-sm ui-focus disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled}
              key={level}
              onClick={() =>
                onChange(
                  THINKING_LEVELS.filter((item) =>
                    item === level ? !selected : value.includes(item),
                  ),
                )
              }
              type="button"
            >
              <span aria-hidden className="thinking-level-keycap">
                <span className="thinking-fader-grip" />
              </span>
              <span className="mt-2 block text-caption whitespace-nowrap text-on-surface-muted group-aria-pressed:font-medium group-aria-pressed:text-on-surface">
                {thinkingLabel(level)}
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-3 text-caption text-on-surface-muted">点击启用，再次点击关闭</p>
    </div>
  )
}
