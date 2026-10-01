import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
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

/** 登录成功后就地关闭弹窗；onOpenChange 也用于遮罩、Esc 与关闭按钮。 */
export function LoginDialog({ open, onOpenChange, ssoErrorCode }: LoginDialogProps) {
  const usernameRef = useRef<HTMLInputElement>(null)
  const ssoErrorMessage = ssoErrorCode ? ssoErrorMessageOf(ssoErrorCode) : undefined
  // 只缓存「开 / 关」这类确定答案；探测出错时没有数据，下次打开弹窗会重新探测。
  const ssoProbe = useQuery({
    enabled: open,
    queryFn: probeSsoLoginEnabled,
    queryKey: [AUTH_QUERY_KEY_ROOT, 'sso-enabled'],
    staleTime: Number.POSITIVE_INFINITY,
  })

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        aria-label="登录 Cue"
        className="max-w-[420px]"
        // 打开时焦点交给用户名；SSO 开启且账号密码区收起时输入框不可聚焦，沿用默认焦点。
        onOpenAutoFocus={(event) => {
          const username = usernameRef.current
          if (username === null || username.closest('[hidden]') !== null) return
          event.preventDefault()
          username.focus()
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
            ssoEnabled={ssoProbe.data ?? false}
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
