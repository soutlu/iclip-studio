/** 在 shared 层把聊天 feature 里「要把工作台打开」的请求传给工作台宿主。 */

import { createContext } from 'react'

export interface WorkbenchOpenRequest {
  /** 聊天里点了「查看」之类要把面板打开的动作；宿主据此忽略用户之前的折叠。 */
  requestOpen: () => void
  /** openToken 每次 requestOpen 递增，消费方只比较是否变化。 */
  openToken: number
}

export const WorkbenchOpenRequestContext = createContext<WorkbenchOpenRequest | null>(null)
