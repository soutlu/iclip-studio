import { useState, type FocusEvent, type KeyboardEvent } from 'react'

/**
 * 提示只在鼠标悬停或按 Tab 移到触发器上时弹出，程序把焦点放回触发器（弹窗收起、开关切换后）不弹。
 *
 * 用法：`rootProps` 给 `TooltipRoot`，`triggerProps` 给 `TooltipTrigger`。拦下 Radix 的聚焦打开，
 * 免得焦点归还时弹出提示、Esc 先关提示再关弹窗；Tab 的按下落在上一个元素上，抬起才落到本触发器，
 * 所以只有键盘移焦会在这里收到 Tab 抬起。
 */
export const useTabTooltip = () => {
  const [open, setOpen] = useState(false)
  return {
    rootProps: { onOpenChange: setOpen, open },
    triggerProps: {
      // Radix 的聚焦处理排在本处理之后，看到 defaultPrevented 就不打开。
      onFocus: (event: FocusEvent) => event.preventDefault(),
      onKeyUp: (event: KeyboardEvent) => {
        if (event.key === 'Tab') setOpen(true)
      },
    },
  }
}
