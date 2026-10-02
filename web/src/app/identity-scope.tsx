import { Fragment, useState, type ReactNode } from 'react'
import { useUser } from '@/shared/auth'

/**
 * 按登录身份划出的一棵子树：身份一变（退出、登录、复核发现换了人）就整棵卸载重建。
 *
 * 订阅连接的身份在握手时定下，换人要重连才生效（合同 §5）；transcript 各池、本地发送状态与组件里的缓存
 * 也都属于当时那个人。不重建的话，新身份会直接看到上一个人读过的对话，订阅也仍按上一个人校验。
 * 首次探测出身份不算变化：打开页面时的那棵树本来就是给这个身份的，换掉只会多建一次连接；
 * 探测中或探测出错时身份未知，同样不算变化。
 */
export function IdentityScope({ children }: { children: ReactNode }) {
  const { data, isSuccess } = useUser()
  const identity = isSuccess ? (data?.id ?? null) : undefined
  const [scope, setScope] = useState({ generation: 0, identity })
  if (identity !== undefined && identity !== scope.identity) {
    setScope({
      generation: scope.identity === undefined ? scope.generation : scope.generation + 1,
      identity,
    })
  }
  return <Fragment key={scope.generation}>{children}</Fragment>
}
