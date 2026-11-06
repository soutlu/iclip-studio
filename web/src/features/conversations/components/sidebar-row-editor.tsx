import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf, NETWORK_FAILURE } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { toast } from '@/shared/ui/toast'
import { SIDEBAR_ROW_BOX } from './sidebar-row-classes'

const MAX_NAME_CHARS = 200

type SidebarRowEditorProps = {
  label: string
  initialValue: string
  placeholder?: string
  leading?: ReactNode
  trailing?: ReactNode
  className?: string
  failureMessage: string
  onSubmit: (value: string) => Promise<unknown>
  onClose: (options: { refocus: boolean }) => void
}

export function SidebarRowEditor({
  label,
  initialValue,
  placeholder,
  leading,
  trailing,
  className,
  failureMessage,
  onSubmit,
  onClose,
}: SidebarRowEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const closedRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const close = () => {
    closedRef.current = true
    onClose({ refocus: document.activeElement === inputRef.current })
  }

  const submit = async (raw: string) => {
    if (busyRef.current || closedRef.current) return
    const value = raw.trim()
    if (!value || value === initialValue) {
      close()
      return
    }
    busyRef.current = true
    try {
      await onSubmit(value)
      close()
    } catch (cause) {
      const message = errorMessageOf(cause, failureMessage)
      setError(message)
      toast.error(message)
    } finally {
      busyRef.current = false
    }
  }

  return (
    <>
      <div
        className={cn(
          SIDEBAR_ROW_BOX,
          'cursor-text bg-top-layer shadow-[var(--shadow-1)] ring-1',
          error ? 'ring-error' : 'ring-outline-variant',
          className,
        )}
        onMouseDown={(event) => {
          const input = inputRef.current
          if (!input || event.target === input) return
          event.preventDefault()
          input.focus()
          input.setSelectionRange(input.value.length, input.value.length)
        }}
        role="presentation"
      >
        {leading}
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          aria-label={label}
          className="sidebar-row-input h-5 min-w-0 flex-1 bg-transparent p-0 placeholder:text-on-surface-faint"
          defaultValue={initialValue}
          maxLength={MAX_NAME_CHARS}
          onBlur={(event) => void submit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit(event.currentTarget.value)
            }
            if (event.key === 'Escape') {
              event.stopPropagation()
              if (!busyRef.current) close()
            }
          }}
          placeholder={placeholder}
          ref={inputRef}
        />
        {trailing}
      </div>
      {error && (
        <p
          className={cn(
            'truncate pt-0.5 pr-2.5 text-caption text-error',
            leading ? 'pl-9' : 'pl-2.5',
          )}
          id={errorId}
          role="alert"
          title={error}
        >
          {retryHint(error)}
        </p>
      )}
    </>
  )
}

const retryHint = (message: string) => {
  if (message.endsWith(NETWORK_FAILURE)) return message
  const reason = message.replace(/[。.！!]+$/, '')
  return `${reason}${reason.includes('：') ? '；' : '，'}请按回车重试`
}
