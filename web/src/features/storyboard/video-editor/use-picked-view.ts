import { useEffect, useEffectEvent, useState } from 'react'
import { z } from 'zod'
import { readStored } from '../editing/browser-storage'

export type Picked = { jobId: string; baseJobId: string; view: 'whole' | 'clips' | 'version' }

export const viewStorageKey = (conversationId: string, rootJobId: string) =>
  `video-editor-view:${conversationId}:${rootJobId}`

const zPicked = z.object({
  jobId: z.string().min(1),
  baseJobId: z.string().min(1),
  view: z.enum(['whole', 'clips', 'version']),
})

const readPicked = (key: string): Picked | undefined => {
  const raw = readStored(key)
  if (raw === null) return undefined
  try {
    const parsed = zPicked.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export const usePickedView = (
  conversationId: string,
  rootJobId: string,
  onStorageFailure: () => void,
) => {
  const key = viewStorageKey(conversationId, rootJobId)
  const [picked, setPicked] = useState(() => readPicked(key))
  const reportStorageFailure = useEffectEvent(onStorageFailure)
  useEffect(() => {
    if (picked === undefined) return
    try {
      window.localStorage.setItem(key, JSON.stringify(picked))
    } catch {
      reportStorageFailure()
    }
  }, [key, picked])
  return [picked, setPicked] as const
}
