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

/** 账号密码区展开时是用户名输入框，SSO 开启、账号密码区收起时是飞书登录按钮。 */
function entryFocusTarget(
  usernameRef: RefObject<HTMLInputElement | null>,
  ssoButtonRef: RefObject<HTMLButtonElement | null>,
): HTMLElement | null {
  const username = usernameRef.current
  if (username !== null && username.closest('[hidden]') === null) return username
  return ssoButtonRef.current
}

/** 登录成功后就地关闭弹窗；onOpenChange 也用于遮罩、Esc 与关闭按钮。 */
export function LoginDialog({ open, onOpenChange, ssoErrorCode }: LoginDialogProps) {
  const usernameRef = useRef<HTMLInputElement>(null)
  const ssoButtonRef = useRef<HTMLButtonElement>(null)
  const ssoErrorMessage = ssoErrorCode ? ssoErrorMessageOf(ssoErrorCode) : undefined
  // 只缓存「开 / 关」这类确定答案；探测出错时没有数据，下次打开弹窗会重新探测。
  const ssoProbe = useQuery({
    enabled: open,
    queryFn: probeSsoLoginEnabled,
    queryKey: [AUTH_QUERY_KEY_ROOT, 'sso-enabled'],
    staleTime: Number.POSITIVE_INFINITY,
  })
  const ssoEnabled = ssoProbe.data ?? false

  // 首次打开时探测晚于自动聚焦返回：账号密码区随之收起，焦点若留在区内或已被浏览器退回 body，
  // 就交给飞书登录按钮。要在浏览器重绘前处理，所以用 layout effect；手动收起时焦点在切换按钮上，不受影响。
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
        // 打开时焦点交给登录入口，而不是标题栏的关闭按钮。
        onOpenAutoFocus={(event) => {
          const target = entryFocusTarget(usernameRef, ssoButtonRef)
          if (target === null) return
          event.preventDefault()
          target.focus()
        }}
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
