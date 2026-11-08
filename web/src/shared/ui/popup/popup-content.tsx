import { Popover } from 'radix-ui'
import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/shared/lib/utils'

export const PopupRoot = Popover.Root
export const PopupAnchor = Popover.Anchor
export const PopupTrigger = Popover.Trigger

export const POPUP_SURFACE_CLASS = [
  'layer-popup rounded-md border-[0.5px] border-border bg-popup-bg shadow-[var(--shadow-2)] backdrop-blur-[40px]',
  'data-[state=closed]:animate-out data-[state=closed]:duration-(--dur-s) data-[state=closed]:ease-(--ease-accel) data-[state=closed]:zoom-out-95 data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:duration-(--dur-m) data-[state=open]:ease-(--ease-decel) data-[state=open]:zoom-in-95 data-[state=open]:fade-in',
].join(' ')

type PopupSurfaceProps = ComponentPropsWithRef<typeof Popover.Content> & {
  showArrow?: boolean
  arrowClassName?: string
  container?: HTMLElement | null
}

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
