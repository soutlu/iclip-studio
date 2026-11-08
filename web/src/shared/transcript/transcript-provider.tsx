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

const transcriptUrl = () =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws`

type TranscriptProviderProps = {
  children: ReactNode
  createSocket?: ((url: string) => WebSocket) | undefined
  identityKey?: number | undefined
}

interface TranscriptInstances {
  createSocket: TranscriptProviderProps['createSocket']
  identityKey: number | undefined
  connection: TranscriptConnection
  localPrompts: LocalPromptStore
  pools: TranscriptPools
}

const createInstances = (
  createSocket: TranscriptProviderProps['createSocket'],
  identityKey: number | undefined,
  previous?: TranscriptInstances,
): TranscriptInstances => {
  const connection = new TranscriptConnection({
    url: transcriptUrl(),
    ...(createSocket === undefined ? {} : { createSocket }),
  })
  const localPrompts =
    previous !== undefined && previous.identityKey === identityKey
      ? previous.localPrompts
      : new LocalPromptStore()
  return {
    connection,
    createSocket,
    identityKey,
    localPrompts,
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
  if (instances.createSocket !== createSocket || instances.identityKey !== identityKey) {
    setInstances(createInstances(createSocket, identityKey, instances))
  }
  const { connection, localPrompts, pools } = instances

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) connection.connect()
    })

    const reviveIfStale = () => {
      if (document.visibilityState === 'hidden') return
      if (connection.health().stale) connection.reconnect()
    }
    document.addEventListener('visibilitychange', reviveIfStale)
    window.addEventListener('focus', reviveIfStale)
    window.addEventListener('online', reviveIfStale)

    return () => {
      cancelled = true
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
