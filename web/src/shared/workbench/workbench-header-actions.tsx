import { use, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { WorkbenchHeaderSlotContext } from './workbench-header-slot-context'

/**
 * 当前页签的渲染器往工作台顶栏右侧放控件（比如 final-cut 的「导出」）。放进去的控件在任何布局下都一直显示，
 * 不跟着顶栏上悬停才出现的「交换 / 折叠」按钮藏起来；React 的事件仍按渲染器里的组件树冒泡。
 * 不在工作台里（没有顶栏）时什么也不画。
 */
export function WorkbenchHeaderActions({ children }: { children: ReactNode }) {
  const slot = use(WorkbenchHeaderSlotContext)
  return slot === null ? null : createPortal(children, slot)
}
