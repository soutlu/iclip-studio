import { useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'

const UNDO_MS = 6000

type FrameReplaceOptions = {
  currentUrl: string | null | undefined
  onApply: (previousUrl: string | null, url: string | null) => Promise<void>
}

export function useFrameReplace({ currentUrl, onApply }: FrameReplaceOptions) {
  const acknowledgedRef = useRef<string | null | undefined>(undefined)
  if (acknowledgedRef.current === undefined) acknowledgedRef.current = currentUrl
  const busyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [pending, setPending] = useState<'replace' | 'undo' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undoable, setUndoable] = useState<{ applied: string; previous: string | null } | null>(
    null,
  )

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const write = async (
    kind: 'replace' | 'undo',
    previous: string | null,
    url: string | null,
    fallback: string,
  ): Promise<boolean> => {
    busyRef.current = true
    setPending(kind)
    setError(null)
    try {
      await onApply(previous, url)
      acknowledgedRef.current = url
      return true
    } catch (cause) {
      acknowledgedRef.current = currentUrl
      setError(errorMessageOf(cause, fallback))
      return false
    } finally {
      busyRef.current = false
      setPending(null)
    }
  }

  const replace = async (url: string): Promise<boolean> => {
    const previous = acknowledgedRef.current === undefined ? currentUrl : acknowledgedRef.current
    if (busyRef.current || previous === undefined) return false
    if (!(await write('replace', previous, url, '替换失败，请重试'))) return false
    clearTimeout(timerRef.current)
    setUndoable({ applied: url, previous })
    timerRef.current = setTimeout(() => setUndoable(null), UNDO_MS)
    return true
  }

  const undo = async () => {
    if (busyRef.current || undoable === null) return
    if (!(await write('undo', undoable.applied, undoable.previous, '撤销失败，请重试'))) return
    clearTimeout(timerRef.current)
    setUndoable(null)
  }

  const acknowledge = () => {
    acknowledgedRef.current = currentUrl
    setError(null)
  }

  return { acknowledge, error, pending, replace, undo, undoable: undoable !== null }
}
