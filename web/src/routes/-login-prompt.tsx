import { createContext, use } from 'react'

const LoginPromptContext = createContext<(() => void) | null>(null)

export const LoginPromptProvider = LoginPromptContext

export function useLoginPrompt() {
  const requireLogin = use(LoginPromptContext)

  if (!requireLogin) {
    throw new Error('useLoginPrompt 必须在应用壳内使用')
  }

  return requireLogin
}
