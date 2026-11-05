import { createContext, use } from 'react'

export interface ShellChrome {
  sidebarOverlay: boolean
  chat?: {
    onCollapse: () => void
  }
  onSwapPanes?: () => void
  composerFocus?: {
    pending: boolean
    request: () => void
    consume: () => void
  }
}

const DEFAULT_SHELL_CHROME: ShellChrome = { sidebarOverlay: false }

export const ShellChromeContext = createContext<ShellChrome>(DEFAULT_SHELL_CHROME)

export const useShellChrome = (): ShellChrome => use(ShellChromeContext)
