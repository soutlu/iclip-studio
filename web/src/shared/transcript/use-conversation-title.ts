/**
 * 页头与工作台共用的对话标题：连接期间收到的改名优先，没收到过就用基线（transcript 页上的标题）。
 *
 * 全局帧不补发（合同 §5），重连后断线期间的改名丢了；流没断时主池只带水位重订、不重读基线。所以重连时
 * 对挂着的对话按 id 补读一次整行，结果落地前保留已收到的改名。补读在途期间又到了改名帧就不用结果：
 * 帧在写入提交后才发，至少和读到的一样新。
 *
 * 标题按连接各存一份：换了连接（换人）就是另一份，不把上一个身份收到的改名带到新身份的页面上。
 */

import { use, useEffect, useSyncExternalStore } from 'react'
import type { TranscriptConnection } from './connection'
import { fetchConversationTitle } from './transcript.api'
import { TranscriptConnectionContext } from './transcript-context'

interface TitleRead {
  controller: AbortController
  /** 补读期间到了改名帧：结果作废。 */
  overtaken: boolean
}

class ConversationTitles {
  private readonly titles = new Map<string, string>()
  /** 挂着的对话与挂着它的界面数；页头与工作台同时挂着同一段时只补读一次。 */
  private readonly held = new Map<string, number>()
  private readonly reads = new Map<string, TitleRead>()
  private readonly listeners = new Set<() => void>()

  constructor(connection: TranscriptConnection) {
    connection.watchSessions((update) => {
      if (update.kind === 'reconnected') {
        for (const conversationId of this.held.keys()) void this.reread(conversationId)
        return
      }
      if (update.kind !== 'title') return
      const read = this.reads.get(update.conversationId)
      if (read !== undefined) read.overtaken = true
      this.set(update.conversationId, update.title)
    })
  }

  get(conversationId: string): string | undefined {
    return this.titles.get(conversationId)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** 登记一处在用这段对话的界面，返回注销函数。 */
  hold(conversationId: string): () => void {
    this.held.set(conversationId, (this.held.get(conversationId) ?? 0) + 1)
    return () => {
      const count = (this.held.get(conversationId) ?? 0) - 1
      if (count > 0) {
        this.held.set(conversationId, count)
        return
      }
      // 在途的补读不中止：读回来的仍是这段对话当前的标题，离开后马上回来（同一 id 换一处挂着）也用得上。
      this.held.delete(conversationId)
    }
  }

  /** 新的一次中止在途那次；失败只记警告，标题保持原值（对话不可见由主池给出读不到的页面）。 */
  private async reread(conversationId: string): Promise<void> {
    this.reads.get(conversationId)?.controller.abort()
    const read: TitleRead = { controller: new AbortController(), overtaken: false }
    this.reads.set(conversationId, read)
    try {
      const title = await fetchConversationTitle(conversationId, read.controller.signal)
      if (this.reads.get(conversationId) === read && !read.overtaken)
        this.set(conversationId, title)
    } catch {
      if (this.reads.get(conversationId) === read)
        console.warn('补读对话标题失败', { conversationId })
    } finally {
      if (this.reads.get(conversationId) === read) this.reads.delete(conversationId)
    }
  }

  private set(conversationId: string, title: string): void {
    if (this.titles.get(conversationId) === title) return
    this.titles.set(conversationId, title)
    for (const listener of this.listeners) listener()
  }
}

const stores = new WeakMap<TranscriptConnection, ConversationTitles>()

const titlesOf = (connection: TranscriptConnection): ConversationTitles => {
  let store = stores.get(connection)
  if (store === undefined) {
    store = new ConversationTitles(connection)
    stores.set(connection, store)
  }
  return store
}

/** 这段对话现在该显示的标题；`baseline` 是 transcript 页上的标题。 */
export const useConversationTitle = (conversationId: string, baseline: string): string => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useConversationTitle 要在 TranscriptProvider 里用')
  const titles = titlesOf(connection)

  useEffect(() => titles.hold(conversationId), [conversationId, titles])

  return useSyncExternalStore(titles.subscribe, () => titles.get(conversationId)) ?? baseline
}
