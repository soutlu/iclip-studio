import { use } from 'react'
import { WorkbenchLayoutContext } from './workbench-layout-context'

/**
 * 渲染器所在的工作台是不是折叠着。折叠时渲染器还挂着、只是藏起来了，正在播放的媒体要自己停下。
 * 不在工作台里时是 false。
 */
export const useWorkbenchCollapsed = (): boolean => use(WorkbenchLayoutContext)?.collapsed ?? false
