import { useEffect, useState } from 'react'
import { formatDuration } from './attachment-format'

export const useElapsed = (since: string): string => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return formatDuration(Math.max(0, (now - Date.parse(since)) / 1000))
}
