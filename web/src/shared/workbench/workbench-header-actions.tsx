import { use, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { WorkbenchHeaderSlotContext } from './workbench-header-slot-context'

/**
 * 将当前页签渲染器提供的操作控件（如 final-cut 的「导出」）挂载到工作台顶栏右侧插槽。
 * 控件在各类布局下均常驻显示，React 事件仍沿渲染器所在组件树冒泡；当不在工作台内（无顶栏插槽）时不渲染任何内容。
 */
export function WorkbenchHeaderActions({ children }: { children: ReactNode }) {
  const slot = use(WorkbenchHeaderSlotContext)
  return slot === null ? null : createPortal(children, slot)
}
