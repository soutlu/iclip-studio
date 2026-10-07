import { cva, type VariantProps } from 'class-variance-authority'
import { useState, type ComponentPropsWithRef } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

export const iconButtonVariants = cva(
  // 置灰用 aria-disabled，按钮仍收得到 :active，所以置灰时撤掉按压缩放。
  'relative inline-grid ui-state cursor-pointer place-items-center rounded-sm ui-focus active:scale-[0.98] aria-disabled:active:scale-100',
  {
    variants: {
      variant: {
        standard: 'bg-transparent text-on-surface-variant',
        tonal: 'bg-secondary-container text-on-secondary-container',
        selected: 'bg-inverse-surface text-inverse-on-surface',
      },
      size: {
        lg: 'hit-48 size-(--control-height-lg)',
        md: 'hit-48 size-(--control-height-md)',
        // sm 与 xs 不扩大热区，避免密排按钮的 48px 点击区域互相覆盖。
        sm: 'size-(--control-height-sm)',
        xs: 'size-(--control-height-xs)',
      },
    },
    defaultVariants: { variant: 'standard', size: 'lg' },
  },
)

const ICON_SIZE = { lg: 'lg', md: 'md', sm: 'md', xs: 'sm' } as const

// 提示统一走共用 Tooltip，不收原生 title，免得两种提示叠在一起。
type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'title'> &
  VariantProps<typeof iconButtonVariants> & {
    // 图标按钮无可见文字，label 必须提供可访问名称。
    label: string
    name: IconName
    /** 悬停或按 Tab 移到按钮上时的提示文字，缺省同 label；与可访问名称不同时才传，如「已复制」或置灰的原因。 */
    tooltip?: string | undefined
  }

/**
 * 图标按钮，自带共用 Tooltip 提示：鼠标悬停或按 Tab 移到按钮上时弹出。
 *
 * 聚焦本身不弹提示：弹窗打开时自动聚焦、菜单或弹窗收起时焦点回到按钮，都会让 Radix 弹出提示，
 * 而 Esc 会先关掉提示、要再按一次才关弹窗。所以拦下 Radix 的聚焦打开，改为 Tab 键在本按钮上抬起时打开。
 *
 * 置灰用 aria-disabled 而不是原生 disabled：原生 disabled 的按钮收不到指针、进不了 tab 序列，置灰时提示就弹不出来。
 * 置灰时按钮仍可聚焦，点击（含 Enter / Space 合成的点击）被拦下，不调用 onClick、也不提交表单。
 * 包在 Radix 的菜单触发器里时，把 disabled 交给触发器：它据此拦自己的按下与按键，再把 disabled 转交给本按钮。
 */
export function IconButton({
  className,
  disabled = false,
  label,
  name,
  onClick,
  onFocus,
  onKeyUp,
  size,
  tooltip,
  type = 'button',
  variant,
  ...props
}: IconButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <TooltipRoot onOpenChange={setOpen} open={open}>
      <TooltipTrigger asChild>
        <button
          aria-disabled={disabled ? true : undefined}
          aria-label={label}
          className={cn(iconButtonVariants({ variant, size }), className)}
          type={type}
          {...props}
          onClick={(event) => {
            if (disabled) {
              event.preventDefault()
              return
            }
            onClick?.(event)
          }}
          onFocus={(event) => {
            onFocus?.(event)
            // Radix 的聚焦处理排在本处理之后，看到 defaultPrevented 就不打开。
            event.preventDefault()
          }}
          onKeyUp={(event) => {
            onKeyUp?.(event)
            // Tab 的按下落在上一个元素上，抬起才落到本按钮：只有键盘移焦会在这里收到 Tab 抬起。
            if (event.key === 'Tab') setOpen(true)
          }}
        >
          <Icon decorative name={name} size={ICON_SIZE[size ?? 'lg']} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </TooltipRoot>
  )
}
