import { useRef } from 'react'
import type { z } from 'zod'

export const readStoredJson = <T>(key: string, schema: z.ZodType<T>): T | undefined => {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return undefined
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export const writeStored = (key: string, value: unknown): boolean => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
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
