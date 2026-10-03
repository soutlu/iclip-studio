/** 应用壳向对话及工作台栏头提供布局操作；业务内容不自行持有分栏状态。 */

import { createContext, use } from 'react'

export interface ShellChrome {
  sidebarOverlay: boolean
  chat?: {
    onCollapse: () => void
  }
  onSwapPanes?: () => void
  /**
   * 侧栏「新建任务」请求首页输入框聚焦。请求可先于首页挂载发出，由壳保留到首页输入框
   * 挂载（或已挂载）时聚焦并 consume，只消费一次。
   */
  composerFocus?: {
    pending: boolean
    request: () => void
    consume: () => void
  }
}

const DEFAULT_SHELL_CHROME: ShellChrome = { sidebarOverlay: false }

export const ShellChromeContext = createContext<ShellChrome>(DEFAULT_SHELL_CHROME)

export const useShellChrome = (): ShellChrome => use(ShellChromeContext)
