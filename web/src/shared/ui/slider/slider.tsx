import { Slider as RadixSlider } from 'radix-ui'
import { cn } from '@/shared/lib/utils'

// 圆点默认 10px，所在页面可以用 --slider-thumb-size 换大小。Radix 把圆点收在轨道里，
// 值为 p 的圆点正中在 直径 / 2 + (100% − 直径) × p
const THUMB = 'var(--slider-thumb-size, 10px)'

type SliderProps = {
  /** 无障碍名称。 */
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** 读屏读出来的取值；不给时读数字。 */
  valueText?: string
  /** 在这个值处画一道刻度（比如不增不减的那一档）。 */
  mark?: number | undefined
  disabled?: boolean
  className?: string
  /** 拖动中、按方向键时报新的值。 */
  onChange: (value: number) => void
  /** 松手、按一下方向键时报一次最后的值，在这一步的 `onChange` 之后；和开始时一样时不报。 */
  onCommit?: (value: number) => void
  onDoubleClick?: (() => void) | undefined
}

/**
 * 细滑杆：2px 的轨道、10px 的圆点，整体点按高度 20px。拖动中要把报出来的值传回 `value`。
 * `slider-root / -track / -range / -thumb / -mark` 是给所在页面改样子的挂点；已走过的那段（range）默认不画。
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  valueText,
  mark,
  disabled = false,
  className,
  onChange,
  onCommit,
  onDoubleClick,
}: SliderProps) {
  const markAt = mark === undefined || max <= min ? undefined : (mark - min) / (max - min)
  return (
    <RadixSlider.Root
      className={cn(
        'slider-root relative flex h-5 min-w-0 cursor-pointer touch-none items-center select-none data-[disabled]:cursor-default data-[disabled]:opacity-(--state-disabled-content)',
        className,
      )}
      disabled={disabled}
      max={max}
      min={min}
      onDoubleClick={disabled ? undefined : onDoubleClick}
      onValueChange={([next]) => {
        if (next !== undefined) onChange(next)
      }}
      onValueCommit={([next]) => {
        // 按方向键时 Radix 先报提交、后报这一步的新值：提交挪到这一步报完之后，调用方总是先收到值再收到提交
        if (next !== undefined) queueMicrotask(() => onCommit?.(next))
      }}
      step={step}
      value={[value]}
    >
      <RadixSlider.Track className="slider-track relative h-0.5 flex-1 rounded-full bg-outline-variant">
        <RadixSlider.Range className="slider-range absolute h-full rounded-full" />
      </RadixSlider.Track>
      {markAt === undefined ? null : (
        <span
          aria-hidden
          className="slider-mark pointer-events-none absolute top-1/2 h-1.5 w-px -translate-x-1/2 -translate-y-1/2 bg-outline"
          data-testid="slider-mark"
          style={{ left: `calc(${THUMB} / 2 + (100% - ${THUMB}) * ${markAt})` }}
        />
      )}
      <RadixSlider.Thumb
        aria-disabled={disabled || undefined}
        aria-label={label}
        aria-valuetext={valueText}
        className="slider-thumb block size-[var(--slider-thumb-size,10px)] rounded-full bg-on-surface ui-focus"
      />
    </RadixSlider.Root>
  )
}
