import { useState, type ReactNode } from 'react'
import { useUser } from '@/shared/auth'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'

/**
 * 登录身份的代号：首次探测出身份记为 0，之后身份每换一次（退出、登录、接口复核发现换了人）加一。
 * 首次探测出身份不算变化：打开页面时的那套连接本来就是给这个身份的，换掉只会多建一次连接；
 * 探测中或探测出错时身份未知，同样不算变化。
 */
const useIdentityKey = (): number => {
  const { data, isSuccess } = useUser()
  const identity = isSuccess ? (data?.id ?? null) : undefined
  const [scope, setScope] = useState({ generation: 0, identity })
  if (identity !== undefined && identity !== scope.identity) {
    setScope({
      generation: scope.identity === undefined ? scope.generation : scope.generation + 1,
      identity,
    })
  }
  return scope.generation
}

type IdentityTranscriptProviderProps = {
  children: ReactNode
  /** 测试注入的连接工厂，原样交给 TranscriptProvider。 */
  createSocket?: ((url: string) => WebSocket) | undefined
}

/**
 * 订阅连接与 transcript 读取状态按登录身份换代：订阅身份在握手时定下，换人要重连才生效（合同 §5），
 * 各池与本地发送状态也都属于当时那个人。只换这一套，界面树照旧，侧栏展开、输入中的内容等界面状态不受影响。
 */
export function IdentityTranscriptProvider({
  children,
  createSocket,
}: IdentityTranscriptProviderProps) {
  return (
    <TranscriptProvider createSocket={createSocket} identityKey={useIdentityKey()}>
      {children}
    </TranscriptProvider>
  )
}
