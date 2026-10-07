import { Popover } from 'radix-ui'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/shared/lib/utils'

export const PopupRoot = Popover.Root
export const PopupAnchor = Popover.Anchor
export const PopupTrigger = Popover.Trigger

/** 浮层表面与进退场动画；弹层与菜单（@/shared/ui/menu）共用同一套外观。 */
export const POPUP_SURFACE_CLASS = [
  'layer-popup rounded-md border-[0.5px] border-border bg-popup-bg shadow-[var(--shadow-2)] backdrop-blur-[40px]',
  'data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:zoom-out-95 data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:duration-(--dur-m) data-[state=open]:ease-(--ease-decel) data-[state=open]:zoom-in-95 data-[state=open]:fade-in',
].join(' ')

type PopupSurfaceProps = ComponentPropsWithoutRef<typeof Popover.Content> & {
  showArrow?: boolean
  /** 箭头填色须与 className 改过的表面底色一致。 */
  arrowClassName?: string
  /** 挂载点，默认 body；宿主在模态弹窗里时挂到宿主内，弹窗外的指针事件被禁用。 */
  container?: HTMLElement | null
}

/** 共用弹层外观；触发按钮的焦点与键盘关闭由 Radix 管理。 */
export function PopupSurface({
  arrowClassName,
  children,
  className,
  container = null,
  showArrow = false,
  ...props
}: PopupSurfaceProps) {
  return (
    <Popover.Portal container={container}>
      <Popover.Content className={cn(POPUP_SURFACE_CLASS, className)} {...props}>
        {children}
        {showArrow ? (
          <Popover.Arrow className={cn('fill-popup-bg', arrowClassName)} height={8} width={16} />
        ) : null}
      </Popover.Content>
    </Popover.Portal>
  )
}
