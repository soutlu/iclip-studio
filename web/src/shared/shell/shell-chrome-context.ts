/** 应用壳向对话及工作台栏头提供布局操作；业务内容不自行持有分栏状态。 */

import { createContext, use } from 'react'

export interface ShellChrome {
  sidebarOverlay: boolean
  chat?: {
    onCollapse: () => void
  }
  onSwapPanes?: () => void
}

const DEFAULT_SHELL_CHROME: ShellChrome = { sidebarOverlay: false }

export const ShellChromeContext = createContext<ShellChrome>(DEFAULT_SHELL_CHROME)

export const useShellChrome = (): ShellChrome => use(ShellChromeContext)
