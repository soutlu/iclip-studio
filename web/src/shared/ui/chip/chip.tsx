import { cva, type VariantProps } from 'class-variance-authority'
import { ToggleGroup } from 'radix-ui'
import { createContext, use, type ComponentPropsWithRef, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { SEGMENTED_ITEM, SEGMENTED_TRACK } from '@/shared/ui/segmented'

/** 分段的尺寸：`regular` 槽高 30px；`compact` 槽高 26px，供在紧凑的标题行、设置行里排。只对 `segmented` 生效。 */
type ChipSize = 'regular' | 'compact'

// 尺寸只在 ChipGroup 上指定，里面的 FilterChip 经 Context 继承
const ChipSizeContext = createContext<ChipSize>('regular')

const groupVariants = cva('', {
  variants: {
    variant: {
      chip: 'flex flex-wrap items-center gap-2',
      // 默认各项等宽；按内容宽排的地方另给 auto-cols-auto
      segmented: ['grid h-7.5 shrink-0 auto-cols-fr grid-flow-col gap-0.5 p-0.5', SEGMENTED_TRACK],
      option: 'flex flex-wrap items-center gap-1.5',
    },
    size: { regular: '', compact: '' },
  },
  compoundVariants: [
    {
      variant: 'segmented',
      size: 'compact',
      class: 'h-6.5 gap-0 rounded-[calc(var(--radius-xs)+2px)]',
    },
  ],
  defaultVariants: { variant: 'chip', size: 'regular' },
})

const itemVariants = cva(
  'relative inline-flex ui-state cursor-pointer items-center text-body-sm text-on-surface-variant ui-focus',
  {
    variants: {
      variant: {
        chip: 'hit-48 h-(--control-height-sm) gap-1.5 rounded-full border border-chip-border bg-chip-bg px-3.5 font-medium data-[state=on]:border-transparent data-[state=on]:bg-state-active data-[state=on]:text-on-surface',
        // 悬停只加深文字：撤掉 ui-state 的叠层色。hit-48 的热区伸出格子，放进会横向滚动的地方时要在那里裁掉
        segmented: [
          'hit-48 h-full min-w-0 justify-center gap-1.5 px-2.5 whitespace-nowrap [--color-state-hover:transparent] [--color-state-pressed:transparent]',
          SEGMENTED_ITEM,
        ],
        // 表单里的选项小块：没选浅灰底，选中 ink 底
        option:
          'hit-48 h-(--control-height-compact) rounded-sm bg-surface-container px-2.5 whitespace-nowrap data-[state=on]:bg-inverse-surface data-[state=on]:text-inverse-on-surface',
      },
      size: { regular: '', compact: '' },
    },
    compoundVariants: [{ variant: 'segmented', size: 'compact', class: 'gap-0.5 rounded-xs px-2' }],
    defaultVariants: { variant: 'chip', size: 'regular' },
  },
)

// 多行分段：一个槽里按列数折行，行高等于单行时的格高
const ROWS_CLASS: Record<ChipSize, string> = {
  regular: 'h-auto grid-flow-row auto-rows-[--spacing(6.5)]',
  compact: 'h-auto grid-flow-row auto-rows-[--spacing(5.5)]',
}

type ChipGroupProps = ComponentPropsWithRef<typeof ToggleGroup.Root> &
  VariantProps<typeof groupVariants> & {
    /** 只对 `segmented`：给了就在一个槽里排成每行这么多列的等宽网格，放不下的折到下一行。 */
    columns?: number
  }

/**
 * 一组小块（Radix ToggleGroup）：单选时是 `radiogroup` / `radio`，整组一个 Tab 停靠点，方向键只挪焦点。
 * 单选时再点一下当前项会报一个空值，要保持总有一项选中的调用方自己忽略它。
 */
export function ChipGroup({ className, columns, size, style, variant, ...props }: ChipGroupProps) {
  const rows = variant === 'segmented' && columns !== undefined
  return (
    <ChipSizeContext value={size ?? 'regular'}>
      <ToggleGroup.Root
        className={cn(
          groupVariants({ variant, size }),
          rows && ROWS_CLASS[size ?? 'regular'],
          className,
        )}
        style={
          rows ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, ...style } : style
        }
        {...props}
      />
    </ChipSizeContext>
  )
}

type FilterChipProps = ComponentPropsWithRef<typeof ToggleGroup.Item> &
  Omit<VariantProps<typeof itemVariants>, 'size'> & {
    children: ReactNode
    leadingIcon?: IconName
  }

export function FilterChip({
  children,
  className,
  leadingIcon,
  variant,
  ...props
}: FilterChipProps) {
  const size = use(ChipSizeContext)
  return (
    <ToggleGroup.Item className={cn(itemVariants({ variant, size }), className)} {...props}>
      {leadingIcon ? <Icon decorative name={leadingIcon} size="sm" /> : null}
      {children}
    </ToggleGroup.Item>
  )
}
