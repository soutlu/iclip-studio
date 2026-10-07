import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { toast } from '@/shared/ui/toast'
import { SIDEBAR_ROW_BOX } from './sidebar-row-classes'

// 名称上限与合同一致（对话标题、合集名都是 1–200 字）；输入框静默截断，不显示计数。
const MAX_NAME_CHARS = 200

type SidebarRowEditorProps = {
  /** 输入框的可访问名，如「重命名 夏季亚麻系列」。 */
  label: string
  /** 原名；新建时为空串。 */
  initialValue: string
  placeholder?: string
  /** 行首图标等，与非编辑态同位。 */
  leading?: ReactNode
  /** 行尾计数等，与非编辑态同位。 */
  trailing?: ReactNode
  className?: string
  /** 保存失败且服务端没给原因时的说明。 */
  failureMessage: string
  /**
   * 提交去掉首尾空白、非空且与原名不同的名字。resolve 后编辑结束；reject 时留在编辑态并显示原因。
   * 调用方应在列表已刷新出新名字后再 resolve，避免退出编辑时闪回旧名。
   */
  onSubmit: (value: string) => Promise<unknown>
  /**
   * 编辑结束：保存成功、取消，或名字为空、没变。refocus 表示结束时焦点还在输入框里（回车或 Esc），
   * 调用方应把焦点还给这一行的主控件；失焦结束时焦点已去了别处，不抢回来。
   */
  onClose: (options: { refocus: boolean }) => void
}

/**
 * 侧栏原位编辑行：整行变成浮起的输入面，几何与普通行一致，标题文字不移位。
 * 进入时全选原名；回车或失焦保存，Esc 放弃；名字为空或没变直接结束、不发请求。
 * 保存失败时描边变红、行下一行说明原因并弹 toast，回车重试，Esc 放弃。
 */
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
  // 回车与失焦可能先后到达，保存中途也可能失焦；同一时刻只认一次提交，结束后不再响应。
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
        // 行本身没有语义，只把落在行内其他位置的按下转给输入框：输入框只有一行字高，
        // 点到行的空白处不该让它失焦（失焦即保存），光标放到末尾。
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
          // 高度取一行字高（20px）并清掉内距：文字与非编辑态的标题逐像素同位，撑满 36px 行高时字会下沉 1px。
          // 焦点由整行浮起的输入面标示，见 conversations.css。
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
              // 只结束编辑，不让外层（如移动端侧栏）把 Esc 当成关闭。
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

/** 原因后面接一句怎么办；原因末尾的句号去掉再接。 */
const retryHint = (message: string) => `${message.replace(/[。.！!]+$/, '')}，回车重试`
