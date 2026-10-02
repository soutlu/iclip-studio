/**
 * 仅缓存连接期间收到的改名；缺失时使用基线标题。全局帧不补发，重连后清空缓存并依赖新基线。
 * 缓存属于收到它的那条连接：换了连接（换人）就清空，不把上一个身份收到的改名带到新身份的页面上。
 */

import { use, useEffect, useState } from 'react'
import type { TranscriptConnection } from './connection'
import { TranscriptConnectionContext } from './transcript-context'

const EMPTY: ReadonlyMap<string, string> = new Map()

interface TitleCache {
  connection: TranscriptConnection
  titles: ReadonlyMap<string, string>
}

export const useSessionTitles = (): { titleOf: (conversationId: string) => string | undefined } => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useSessionTitles 要在 TranscriptProvider 里用')

  const [cache, setCache] = useState<TitleCache>({ connection, titles: EMPTY })
  if (cache.connection !== connection) setCache({ connection, titles: EMPTY })

  useEffect(
    () =>
      connection.watchSessions((update) => {
        if (update.kind === 'reconnected') {
          setCache({ connection, titles: EMPTY })
          return
        }
        if (update.kind !== 'title') return
        setCache((current) =>
          // 旧连接收尾前到的帧不落进新连接的缓存。
          current.connection !== connection ||
          current.titles.get(update.conversationId) === update.title
            ? current
            : {
                connection,
                titles: new Map(current.titles).set(update.conversationId, update.title),
              },
        )
      }),
    [connection],
  )

  return { titleOf: (conversationId: string) => cache.titles.get(conversationId) }
}
