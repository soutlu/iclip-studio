import { useRef } from 'react'

export const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export const useStorageFailureNotice = (message: string, onNotice: (message: string) => void) => {
  const reportedRef = useRef(false)
  return () => {
    if (reportedRef.current) return
    reportedRef.current = true
    onNotice(message)
  }
}
