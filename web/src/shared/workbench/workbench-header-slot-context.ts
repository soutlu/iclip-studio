import { createContext } from 'react'

/** 工作台顶栏右侧给当前页签放控件的那个元素（`WorkbenchHost` 提供，见 `WorkbenchHeaderActions`）；还没挂上时是 null。 */
export const WorkbenchHeaderSlotContext = createContext<HTMLElement | null>(null)
