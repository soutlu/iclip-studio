import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'

// 照「内容与样式」里的文字框：改字停下 300 毫秒再写进 final-cut
const COMMIT_DELAY_MS = 300

/**
 * 文字框的改字：改了先留在框里（`draft`，没改时是 null），停下 300 毫秒再交给 `write`；输入法拼字时不计时，
 * 焦点离开、框没了时把没写的立刻写进去。`fieldProps` 原样放到文字框上。
 */
export function usePausedCommit(write: (text: string) => void) {
  const [draft, setDraft] = useState<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeRef = useRef(write)
  useLayoutEffect(() => {
    writeRef.current = write
  })
  const flush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    const text = draftRef.current
    if (text === null) return
    draftRef.current = null
    setDraft(null)
    writeRef.current(text)
  }, [])
  useEffect(() => flush, [flush])

  const composingRef = useRef(false)
  const schedule = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = composingRef.current ? null : setTimeout(flush, COMMIT_DELAY_MS)
  }

  return {
    draft,
    fieldProps: {
      onBlur: flush,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        draftRef.current = event.target.value
        setDraft(event.target.value)
        schedule()
      },
      onCompositionEnd: () => {
        composingRef.current = false
        schedule()
      },
      onCompositionStart: () => {
        composingRef.current = true
        schedule()
      },
    },
  }
}
