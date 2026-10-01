import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { TranscriptConnection } from './connection'
import { LocalPromptStore } from './local-prompts'
import { TranscriptReaders } from './readers'
import {
  LocalPromptsContext,
  TranscriptConnectionContext,
  TranscriptReadersContext,
} from './transcript-context'

/** WebSocket 复用同源 /api 反向代理。 */
const transcriptUrl = () =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws`

type TranscriptProviderProps = {
  children: ReactNode
  createSocket?: ((url: string) => WebSocket) | undefined
}

export function TranscriptProvider({ children, createSocket }: TranscriptProviderProps) {
  const connection = useMemo(
    () =>
      new TranscriptConnection({
        url: transcriptUrl(),
        ...(createSocket === undefined ? {} : { createSocket }),
      }),
    [createSocket],
  )
  const readers = useMemo(() => new TranscriptReaders(connection), [connection])
  // 本地发送状态跟着 Provider 走：同一个 Provider 下切换对话不丢，换一个 Provider（如测试）互不串。
  const localPrompts = useMemo(() => new LocalPromptStore(), [])

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
      connection.close()
    }
  }, [connection])

  return (
    <TranscriptConnectionContext value={connection}>
      <TranscriptReadersContext value={readers}>
        <LocalPromptsContext value={localPrompts}>{children}</LocalPromptsContext>
      </TranscriptReadersContext>
    </TranscriptConnectionContext>
  )
}
