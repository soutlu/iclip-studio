import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { TranscriptConnection } from './connection'
import { LocalPromptStore } from './local-prompts'
import { MainTranscriptPool } from './main-pool'
import { SubAgentTranscriptPool } from './sub-agent-pool'
import {
  LocalPromptsContext,
  TranscriptConnectionContext,
  TranscriptPoolsContext,
  type TranscriptPools,
} from './transcript-context'

/** WebSocket 复用同源 /api 反向代理。 */
const transcriptUrl = () =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws`

type TranscriptProviderProps = {
  children: ReactNode
  createSocket?: ((url: string) => WebSocket) | undefined
  /**
   * 登录身份的代号，宿主在换人时换一个值。代号一变就换一套连接、本地发送状态与读取池，旧的一套照常关掉：
   * 订阅身份在握手时定下（合同 §5），这些状态都属于当时那个人。只换这一套，子树不重新挂载。
   */
  identityKey?: number | undefined
}

/** 一个身份用的一套连接与读取状态，连同建它时的连接工厂与身份代号。 */
interface TranscriptInstances {
  createSocket: TranscriptProviderProps['createSocket']
  identityKey: number | undefined
  connection: TranscriptConnection
  localPrompts: LocalPromptStore
  pools: TranscriptPools
}

/** 建一套新的连接与读取池；`previous` 是同一身份的上一套时沿用它的本地发送状态。 */
const createInstances = (
  createSocket: TranscriptProviderProps['createSocket'],
  identityKey: number | undefined,
  previous?: TranscriptInstances,
): TranscriptInstances => {
  const connection = new TranscriptConnection({
    url: transcriptUrl(),
    ...(createSocket === undefined ? {} : { createSocket }),
  })
  // 本地发送状态跟着身份走：同一身份下切换对话、换连接工厂都不丢，换人或换一个 Provider（如测试）互不串。
  const localPrompts =
    previous !== undefined && previous.identityKey === identityKey
      ? previous.localPrompts
      : new LocalPromptStore()
  return {
    connection,
    createSocket,
    identityKey,
    localPrompts,
    // 主池按本地发送状态决定能否淘汰、重读前后是否要再读一次（照 Kimi 的 hasPendingLocalWork / getLocalTurnState）。
    pools: {
      main: new MainTranscriptPool({ connection, localPrompts }),
      sub: new SubAgentTranscriptPool(connection),
    },
  }
}

export function TranscriptProvider({
  children,
  createSocket,
  identityKey,
}: TranscriptProviderProps) {
  const [instances, setInstances] = useState(() => createInstances(createSocket, identityKey))
  // 身份换代或连接工厂换了（按引用比，测试里每次重渲染给的新工厂也算）就换连接与读取池；旧的在下面 effect 的清理里关掉。
  if (instances.createSocket !== createSocket || instances.identityKey !== identityKey) {
    setInstances(createInstances(createSocket, identityKey, instances))
  }
  const { connection, localPrompts, pools } = instances

  useEffect(() => {
    connection.connect()

    // 后台连接可能失活且不触发 close；visibilitychange、focus 和 online 共用检测，必要时立即重连。
    const reviveIfStale = () => {
      if (document.visibilityState === 'hidden') return
      if (connection.health().stale) connection.reconnect()
    }
    document.addEventListener('visibilitychange', reviveIfStale)
    window.addEventListener('focus', reviveIfStale)
    window.addEventListener('online', reviveIfStale)

    return () => {
      document.removeEventListener('visibilitychange', reviveIfStale)
      window.removeEventListener('focus', reviveIfStale)
      window.removeEventListener('online', reviveIfStale)
      pools.main.close()
      pools.sub.close()
      connection.close()
    }
  }, [connection, pools])

  return (
    <TranscriptConnectionContext value={connection}>
      <TranscriptPoolsContext value={pools}>
        <LocalPromptsContext value={localPrompts}>{children}</LocalPromptsContext>
      </TranscriptPoolsContext>
    </TranscriptConnectionContext>
  )
}
