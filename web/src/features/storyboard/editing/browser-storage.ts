import { useRef } from 'react'
import type { z } from 'zod'

/** 读浏览器里存的 JSON 并按 `schema` 校验；没存过、读不了或格式不对时为 undefined。 */
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

/** 把 `value` 按 JSON 存进浏览器；存不进去（隐私模式、超出容量）时返回 false。 */
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
