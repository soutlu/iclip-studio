import { useQuery } from '@tanstack/react-query'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { AUTH_QUERY_KEY_ROOT, probeSsoLoginEnabled } from '@/shared/auth'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { ssoErrorMessageOf } from '../sso-error'
import { LoginForm } from './login-form'

type LoginDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  ssoErrorCode?: string | undefined
}

function entryFocusTarget(
  usernameRef: RefObject<HTMLInputElement | null>,
  ssoButtonRef: RefObject<HTMLButtonElement | null>,
): HTMLElement | null {
  const username = usernameRef.current
  if (username !== null && username.closest('[hidden]') === null) return username
  return ssoButtonRef.current
}

export function LoginDialog({ open, onOpenChange, ssoErrorCode }: LoginDialogProps) {
  const usernameRef = useRef<HTMLInputElement>(null)
  const ssoButtonRef = useRef<HTMLButtonElement>(null)
  const ssoErrorMessage = ssoErrorCode ? ssoErrorMessageOf(ssoErrorCode) : undefined
  const ssoProbe = useQuery({
    enabled: open,
    queryFn: probeSsoLoginEnabled,
    queryKey: [AUTH_QUERY_KEY_ROOT, 'sso-enabled'],
    staleTime: Number.POSITIVE_INFINITY,
  })
  const ssoEnabled = ssoProbe.data ?? false

  // 区域收起（hidden）后，其中的焦点会留在原处或被浏览器退回 body；要在重绘前改交飞书登录按钮，所以用 layout effect。
  useLayoutEffect(() => {
    if (!open || !ssoEnabled) return
    const active = document.activeElement
    const focusLost = active === null || active === document.body
    if (!focusLost && active.closest('[hidden]') === null) return
    ssoButtonRef.current?.focus()
  }, [open, ssoEnabled])

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        aria-label="登录 Cue"
        className="max-w-[420px]"
        // Radix 默认聚焦第一个可聚焦元素，即标题栏的关闭按钮。
        onOpenAutoFocus={(event) => {
          const target = entryFocusTarget(usernameRef, ssoButtonRef)
          if (target === null) return
          event.preventDefault()
          target.focus()
        }}
        returnFocus
      >
        <DialogHeader closeLabel="关闭登录" title="欢迎登录 Cue" />
        <DialogBody>
          {ssoProbe.isError ? (
            <InlineAlert
              action={{ label: '重试', onClick: () => void ssoProbe.refetch() }}
              className="mb-3"
              message="飞书登录暂不可用，请使用账号密码登录"
            />
          ) : null}
          <LoginForm
            ssoButtonRef={ssoButtonRef}
            ssoEnabled={ssoEnabled}
            initialErrorMessage={ssoErrorMessage}
            onSuccess={() => onOpenChange(false)}
            usernameRef={usernameRef}
          />
          {/* MiSans 许可第 1 条要求在软件中注明使用了该字体，许可全文随产物发布。 */}
          <p className="mt-4 text-right text-caption text-on-surface-faint">
            <a
              className="rounded-xs ui-focus hover:text-on-surface-variant hover:underline"
              href="/licenses/MiSans.txt"
              rel="noopener noreferrer"
              target="_blank"
            >
              字体：MiSans
            </a>
          </p>
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
