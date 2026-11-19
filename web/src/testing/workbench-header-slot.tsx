import { useState, type ReactNode } from 'react'
import { WorkbenchHeaderSlotContext } from '@/shared/workbench'

/** 替工作台顶栏右侧的挂点：单独渲染页签的渲染器时，它经 `WorkbenchHeaderActions` 放的控件画在这里。 */
export function WithHeaderSlot({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <>
      <div ref={setSlot} />
      <WorkbenchHeaderSlotContext value={slot}>{children}</WorkbenchHeaderSlotContext>
    </>
  )
}
